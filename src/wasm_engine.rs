use anyhow::{Context as _, Result};
use rquickjs::{AsyncContext, AsyncRuntime, Function, Object, Ctx, Value, TypedArray};
use std::fs;
use std::path::Path;
use std::cell::RefCell;
use std::rc::Rc;
use wasmtime::{Engine, Module, Store, Linker, Instance, Extern};
use std::time::Duration;

// Timeout for WASM initialization (30 seconds like MTranServer)
const WASM_INIT_TIMEOUT_MS: u64 = 30000;

pub struct WasmEngine {
    _runtime: AsyncRuntime,
    context: AsyncContext,
    wasm_engine: Engine,
}

struct WasmStore;

impl WasmEngine {
    pub async fn new(wasm_path: &Path, js_path: &Path) -> Result<Self> {
        let runtime = AsyncRuntime::new().context("Failed to create QuickJS runtime")?;
        let context = AsyncContext::full(&runtime).await.context("Failed to create QuickJS context")?;
        let wasm_engine = Engine::default();

        let wasm_bytes = fs::read(wasm_path).context("Failed to read WASM file")?;
        let js_source = fs::read_to_string(js_path).context("Failed to read JS glue file")?;

        let engine_clone = wasm_engine.clone();

        // Async wrapper with timeout
        let init_result = tokio::time::timeout(
            Duration::from_millis(WASM_INIT_TIMEOUT_MS),
            async {
                context.with(move |ctx: Ctx| {
                    let global = ctx.globals();

                    // Create Module object with official Bergamot interface
                    let module = Object::new(ctx.clone())?;
                    let wasm_array = TypedArray::<u8>::new(ctx.clone(), wasm_bytes)?;
                    module.set("wasmBinary", wasm_array)?;

                    // Logging callbacks (required by bergamot-translator.js)
                    let print = Function::new(ctx.clone(), |msg: String| {
                        println!("[Bergamot]: {}", msg);
                    })?;
                    module.set("print", print)?;
                    let print_err = Function::new(ctx.clone(), |msg: String| {
                        eprintln!("[Bergamot Error]: {}", msg);
                    })?;
                    module.set("printErr", print_err)?;

                    // onAbort callback (required by bergamot-translator.js)
                    let ctx_abort = ctx.clone();
                    let on_abort = Function::new(ctx.clone(), move |msg: String| {
                        eprintln!("[Bergamot Abort]: {}", msg);
                        let _ = ctx_abort.throw(msg);
                    })?;
                    module.set("onAbort", on_abort)?;

                    // onRuntimeInitialized callback - this is critical!
                    // The glue code calls this when WASM is ready
                    let ctx_init = ctx.clone();
                    let on_init = Function::new(ctx.clone(), move |_module_obj: Value| {
                        println!("[WASM] Runtime initialized successfully");
                        Ok::<_, rquickjs::Error>(())
                    })?;
                    module.set("onRuntimeInitialized", on_init)?;

                    // Prepare for WebAssembly polyfill
                    let web_assembly = Object::new(ctx.clone())?;

                    // WebAssembly.instantiate(bytes, imports) - the glue code calls this
                    let ctx_instantiate = ctx.clone();
                    let engine_instantiate = engine_clone.clone();
                    let wasm_bytes_instantiate = wasm_bytes.clone();

                    web_assembly.set("instantiate", Function::new(ctx.clone(), move |_bytes: Value, _imports: Value| {
                        let wasm_binary = wasm_bytes_instantiate.clone();

                        // Create Store and Linker
                        let mut store = Store::new(&engine_instantiate, WasmStore);
                        let mut linker = Linker::new(&engine_instantiate);

                        // Allow all functions (we'll provide no-op implementations for imports)
                        linker.allow_unfunctions().unwrap();

                        // Parse WASM to get exports
                        let module = Module::new(&engine_instantiate, &wasm_binary)
                            .map_err(|e| rquickjs::Error::new_from_js(&format!("WASM Compile Error: {}", e), "Error"))?;

                        // Instantiate
                        let instance = linker.instantiate(&mut store, &module)
                            .map_err(|e| rquickjs::Error::new_from_js(&format!("Instantiation failed: {}", e), "Error"))?;

                        // Create JS object for the instance with proper exports
                        let js_instance = Object::new(ctx_instantiate.clone())?;
                        let exports_obj = Object::new(ctx_instantiate.clone())?;

                        // Export all WASM functions with wrappers
                        export_wasm_functions(&ctx_instantiate, &mut store, &instance, &exports_obj)?;

                        js_instance.set("exports", exports_obj)?;
                        Ok::<_, rquickjs::Error>(js_instance)
                    })?)?;

                    // WebAssembly.Memory constructor - needs to return a proper memory object
                    let ctx_memory = ctx.clone();
                    web_assembly.set("Memory", Function::new(ctx.clone(), move |_descriptor: Object| {
                        let memory = Object::new(ctx_memory.clone())?;
                        // Initial memory with 256 pages (16MB), max 4GB
                        memory.set("buffer", Value::Null(ctx_memory.clone()))?;
                        memory.set("grow", Function::new(ctx_memory.clone(), |_delta: i32| Ok::<i32, rquickjs::Error>(256))?)?;
                        Ok::<_, rquickjs::Error>(memory)
                    })?)?;

                    // WebAssembly.Table constructor
                    web_assembly.set("Table", Function::new(ctx.clone(), |_descriptor: Object| {
                        let table = Object::new(ctx.clone())?;
                        table.set("length", 0)?;
                        Ok::<_, rquickjs::Error>(table)
                    })?)?;

                    global.set("WebAssembly", web_assembly)?;
                    global.set("Module", module)?;

                    // Load and execute the official Bergamot glue code
                    if let Err(e) = ctx.eval::<(), _>(&js_source) {
                        let msg = e.to_string();
                        let stack = ctx.catch().as_exception()
                            .and_then(|ex| ex.stack().map(|s| format!("\nStack: {}", s)))
                            .unwrap_or_default();
                        eprintln!("[WASM Glue Error] {}{}", msg, stack);
                        return Err(e.into());
                    }

                    // Call loadBergamot to initialize the WASM module
                    let load_bergamot: Function = global.get("loadBergamot")?;
                    let module_obj: Object = global.get("Module")?;

                    // The loadBergamot function will call onRuntimeInitialized when ready
                    load_bergamot.call::<_, ()>((module_obj,))?;

                    println!("[WASM] Bergamot module loaded successfully");
                    Ok::<_, anyhow::Error>(())
                }).await
            }
        ).await;

        match init_result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e).context("WASM initialization failed"),
            Err(_) => return Err(anyhow::anyhow!("WASM initialization timed out after {}ms", WASM_INIT_TIMEOUT_MS)),
        }

        Ok(Self {
            _runtime: runtime,
            context,
            wasm_engine,
        })
    }

    pub async fn load_model(&self, from: &str, to: &str, model_dir: &Path) -> Result<()> {
        // Find model files
        let mut files = HashMap::new();
        for entry in fs::read_dir(model_dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            let bytes = fs::read(&path)?;

            if name.contains("model") && name.ends_with(".bin") {
                if name.contains("s2t") || name.contains("lex") {
                    files.insert("lex", bytes);
                } else {
                    files.insert("model", bytes);
                }
            } else if name.starts_with("srcvocab") {
                files.insert("srcvocab", bytes);
            } else if name.starts_with("trgvocab") {
                files.insert("trgvocab", bytes);
            }
        }

        if files.len() < 4 {
            anyhow::bail!("Missing model files in {}. Found: {:?}", model_dir.display(), files.keys());
        }

        let from = from.to_string();
        let to = to.to_string();

        self.context.with(move |ctx: Ctx| {
            // Use the engine.loadModel function from the adapter
            let load_fn: Function = ctx.eval("engine.loadModel")?;

            let files_obj = Object::new(ctx.clone())?;
            for (k, v) in files {
                let arr = TypedArray::<u8>::new(ctx.clone(), v)?;
                files_obj.set(k, arr)?;
            }

            load_fn.call::<_, ()>((from, to, files_obj))?;
            Ok::<_, anyhow::Error>(())
        }).await?;

        Ok(())
    }

    pub async fn translate(&self, text: &str, from: &str, to: &str) -> Result<String> {
        let text = text.to_string();
        let from = from.to_string();
        let to = to.to_string();

        self.context.with(move |ctx: Ctx| {
            let translate_fn: Function = ctx.eval("engine.translate")?;
            let result: String = translate_fn.call((text, from, to))?;
            Ok(result)
        }).await
    }
}

// Helper to export WASM functions to JS
fn export_wasm_functions(ctx: &Ctx, store: &mut Store<WasmStore>, instance: &Instance, exports_obj: &Object) -> Result<(), rquickjs::Error> {
    for export in instance.exports(store) {
        let name = export.name();
        match export.into_extern() {
            Extern::Func(func) => {
                let func_type = func.ty(store);
                let param_count = func_type.params().len();

                // Create a JS function that wraps the WASM function
                let ctx_clone = ctx.clone();
                let func_clone = func.clone();
                let store_clone = store.clone();

                let wrapper = Function::new(ctx.clone(), move |_args: Vec<Value>| {
                    // Call the WASM function with appropriate parameters
                    // For now, return a placeholder - proper implementation needs type-aware wrapping
                    Ok::<Value, rquickjs::Error>(Value::undefined(ctx_clone.clone()))
                })?;

                exports_obj.set(name, wrapper)?;
            }
            Extern::Memory(_) => {
                // Export memory as a typed array view
                exports_obj.set(name, 0)?;
            }
            Extern::Table(_) => {
                exports_obj.set(name, 0)?;
            }
            Extern::Global(_) => {
                exports_obj.set(name, 0)?;
            }
        }
    }
    Ok(())
}

// Add HashMap import
use std::collections::HashMap;