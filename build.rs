const COMMANDS: &[&str] = &["register_bridge", "eval_result"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
