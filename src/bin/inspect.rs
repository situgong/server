use wasmtime::*;
use std::fs;

fn main() -> Result<()> {
    let engine = Engine::default();
    let wasm_path = "d:\\tools\\server\\wasm\\bergamot-translator.wasm";
    
    println!("Loading WASM from: {}", wasm_path);
    let module = Module::from_file(&engine, wasm_path)?;
    
    println!("Imports:");
    for import in module.imports() {
        println!("  Module: {}, Name: {}, Type: {:?}", import.module(), import.name(), import.ty());
    }
    
    println!("\nExports:");
    for export in module.exports() {
        println!("  Name: {}, Type: {:?}", export.name(), export.ty());
    }
    
    Ok(())
}
