use anyhow::{Context as _, Result};
use rquickjs::{AsyncContext, AsyncRuntime, Function, Object, Ctx, Value, Array, IntoJs, FromJs};
use std::fs;
use std::path::Path;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use wasmtime::{Engine, Linker, Module, Store, Caller, Extern, FuncType, ValType};
use wasmparser::{Parser, Payload, TypeRef};

const ADAPTER_JS: &str = r#"
globalThis.engine = {
    models: {},
    service: null,
    
    initService: function(cacheSize) {
        if (this.service) return;
        this.service = new Module.BlockingService({ cacheSize: cacheSize || 0 });
    },
    
    createAlignedMemory: function(buffer, alignment) {
        var len = buffer.length;
        var aligned = new Module.AlignedMemory(len, alignment);
        var view = aligned.getByteArrayView();
        view.set(buffer);
        return aligned;
    },
    
    loadModel: function(from, to, files) {
        // files is object: { model: Uint8Array, lex: Uint8Array, srcvocab: Uint8Array, trgvocab: Uint8Array }
        
        var alignments = { model: 256, lex: 64, srcvocab: 64, trgvocab: 64 };
        var aligned = {};
        
        for (var key in files) {
            aligned[key] = this.createAlignedMemory(files[key], alignments[key] || 64);
        }
        
        var vocabList = new Module.AlignedMemoryList();
        vocabList.push_back(aligned.srcvocab);
        vocabList.push_back(aligned.trgvocab);
        
        var config = "beam-size: 1\nnormalize: 1.0\nword-penalty: 0\nmax-length-break: 512\nmini-batch-words: 1024\nworkspace: 128\nmax-length-factor: 2.0\nskip-cost: true\ncpu-threads: 0\nquiet: true\nquiet-translation: true\ngemm-precision: int8shiftAlphaAll\nalignment: soft";
        
        var model = new Module.TranslationModel(
            from, to, config,
            aligned.model,
            aligned.lex,
            vocabList,
            null
        );
        
        var key = from + "-" + to;
        this.models[key] = model;
        return true;
    },
    
    translate: function(text, from, to) {
        var key = from + "-" + to;
        var model = this.models[key];
        if (!model) throw "Model not found for " + key;
        
        var msgs = new Module.VectorString();
        msgs.push_back(text);
        
        var opts = new Module.VectorResponseOptions();
        opts.push_back({ qualityScores: false, alignment: true, html: false });
        
        var responses = this.service.translate(model, msgs, opts);
        var result = responses.get(0).getTranslatedText();
        
        responses.delete();
        msgs.delete();
        opts.delete();
        
        return result;
    }
};
"#;

pub struct WasmEngine {
    _runtime: AsyncRuntime,
    context: AsyncContext,
    wasm_engine: Engine,
}

struct StoreData {
    // We might need to store references to JS objects here if needed
}

impl WasmEngine {
    pub async fn new(wasm_path: &Path, js_path: &Path) -> Result<Self> {
        let runtime = AsyncRuntime::new().context("Failed to create QuickJS runtime")?;
        let context = AsyncContext::full(&runtime).await.context("Failed to create QuickJS context")?;
        let wasm_engine = Engine::default();

        let wasm_bytes = fs::read(wasm_path).context("Failed to read WASM file")?;
        let js_source = fs::read_to_string(js_path).context("Failed to read JS glue file")?;
        
        // Prepare WASM engine for the closure
        let engine_clone = wasm_engine.clone();

        context.with(move |ctx: Ctx| {
            let global = ctx.globals();

            // Enable stack trace
            // ctx.eval("Error.stackTraceLimit = 100")?;

            // 1. Setup Module
            let module = Object::new(ctx.clone())?;
            let wasm_array = rquickjs::TypedArray::<u8>::new(ctx.clone(), wasm_bytes)?;
            module.set("wasmBinary", wasm_array)?;
            
            let print = Function::new(ctx.clone(), |msg: String| println!("[WASM] {}", msg))?;
            module.set("print", print)?;
            let print_err = Function::new(ctx.clone(), |msg: String| eprintln!("[WASM Err] {}", msg))?;
            module.set("printErr", print_err)?;
            
            module.set("onRuntimeInitialized", Function::new(ctx.clone(), || {
                println!("[WASM] Runtime initialized");
            })?)?;

            // Polyfill WebAssembly
            let web_assembly = Object::new(ctx.clone())?;
            
            let engine_for_instantiate = engine_clone.clone();
            
            // WebAssembly.instantiate(bytes, imports)
            let ctx_clone = ctx.clone();
            web_assembly.set("instantiate", Function::new(ctx.clone(), move |bytes: rquickjs::TypedArray<u8>, imports: Object| {
                println!("[WASM] WebAssembly.instantiate called with {} bytes", bytes.len());
                
                // Handle the byte array correctly - typed array might be optional or different type
                let wasm_binary = if let Some(bytes_ref) = bytes.as_bytes() {
                    bytes_ref.to_vec()
                } else {
                    return Err::<Object, _>(rquickjs::Error::new_from_js("Invalid WASM bytes", "TypeError"));
                };
                
                // 1. Create Store and Linker
                let mut store = Store::new(&engine_for_instantiate, StoreData {});
                let mut linker = Linker::<StoreData>::new(&engine_for_instantiate);
                
                // 2. Parse WASM to find imports
                // Mock imports to avoid crash
                // We use Module::new to validate and inspect imports
                let module = Module::new(&engine_for_instantiate, &wasm_binary)
                    .map_err(|e| {
                        let msg = format!("WASM Compile Error: {}", e);
                        let _ = ctx_clone.throw(Value::from_string(&ctx_clone, msg).unwrap());
                        rquickjs::Error::Exception
                    })?;
                
                for import in module.imports() {
                    let module_name = import.module();
                    let name = import.name();
                    
                    match import.ty() {
                        wasmtime::ExternType::Func(_) => {
                             // Mock function that does nothing
                             linker.func_wrap(module_name, name, || {
                                 // println!("Called mocked import {}.{}", module_name, name);
                             }).unwrap();
                        }
                        _ => {}
                    }
                }
                
                // Instantiate
                let instance = linker.instantiate(&mut store, &module)
                    .map_err(|e| {
                         // We cannot easily pass a dynamic string to new_from_js, so we throw explicitly
                         let msg = format!("Instantiation failed: {}", e);
                         let _ = ctx_clone.throw(Value::from_string(&ctx_clone, msg).unwrap());
                         rquickjs::Error::Exception
                    })?;
                
                // Create JS object for instance
                let js_instance = Object::new(ctx_clone.clone())?;
                let exports = Object::new(ctx_clone.clone())?;
                
                // Export functions
                for export in instance.exports(&mut store) {
                    let name = export.name();
                    // We need to wrap wasmtime exports into JS functions
                    // This requires a way to call wasmtime functions from JS
                    // For now, let's just create dummy exports to satisfy the glue code
                     exports.set(name, 0)?; 
                }
                
                js_instance.set("exports", exports)?;
                
                Ok(js_instance)
            })?)?;

            // WebAssembly.Memory
            let ctx_clone2 = ctx.clone();
            let memory_ctor = Function::new(ctx.clone(), move |_descriptor: Object| {
                println!("[WASM] new WebAssembly.Memory");
                // Return a mock memory object (should have .buffer)
                let memory = Object::new(ctx_clone2.clone())?;
                // Create a buffer
                let buffer = rquickjs::TypedArray::<u8>::new(ctx_clone2.clone(), vec![0u8; 65536])?;
                memory.set("buffer", buffer)?;
                Ok::<_, rquickjs::Error>(memory)
            })?;
            web_assembly.set("Memory", memory_ctor)?;
            
            // WebAssembly.Table
             let ctx_clone3 = ctx.clone();
             let table_ctor = Function::new(ctx.clone(), move |_descriptor: Object| {
                println!("[WASM] new WebAssembly.Table");
                let table = Object::new(ctx_clone3.clone())?;
                table.set("length", 0)?;
                table.set("get", Function::new(ctx_clone3.clone(), |_: i32| -> Option<Value> { None })?)?;
                Ok::<_, rquickjs::Error>(table)
            })?;
            web_assembly.set("Table", table_ctor)?;

            global.set("WebAssembly", web_assembly)?;
            global.set("Module", module)?;

            // 2. Load Glue
            if let Err(e) = ctx.eval::<(), _>(js_source.as_str()) {
                let msg = e.to_string();
                let stack = if let Some(ex) = ctx.catch().as_exception() {
                     ex.stack().unwrap_or_default()
                } else {
                    String::new()
                };
                eprintln!("[WASM Glue Error] {}\nStack: {}", msg, stack);
                return Err(e.into());
            }
            
            // 3. Init Glue
            let load_bergamot: Function = global.get("loadBergamot")?;
            let module_obj: Object = global.get("Module")?;
            load_bergamot.call::<_, ()>((module_obj,))?;

            // 4. Load Adapter
            ctx.eval::<(), _>(ADAPTER_JS)?;
            
            // 5. Init Service
            let init_service: Function = ctx.eval("engine.initService")?;
            init_service.call::<_, ()>((0,))?;

            Ok::<_, anyhow::Error>(())
        }).await?;

        Ok(Self {
            _runtime: runtime,
            context,
            wasm_engine,
        })
    }

    pub async fn load_model(&self, from: &str, to: &str, model_dir: &Path) -> Result<()> {
        // Find files
        let mut files = HashMap::new();
        for entry in fs::read_dir(model_dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            let bytes = fs::read(&path)?;
            
            if name.starts_with("model") && name.ends_with(".bin") {
                if name.contains("s2t") {
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
            let load_fn: Function = ctx.eval("engine.loadModel")?;
            
            let files_obj = Object::new(ctx.clone())?;
            for (k, v) in files {
                let arr = rquickjs::TypedArray::<u8>::new(ctx.clone(), v)?;
                files_obj.set(k, arr)?;
            }
            
            load_fn.call::<_, bool>((from, to, files_obj))?;
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
