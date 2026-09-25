#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--mcp") {
        app_lib::mcp::stdio::run();
        return;
    }
    app_lib::run();
}
