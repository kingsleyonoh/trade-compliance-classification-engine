# Windows `setup.exe` UAC Elevation

- **Symptom:** `cargo test` or `cargo run --bin setup -- --dry-run` fails on Windows with `The requested operation requires elevation. (os error 740)` before the Rust binary executes.
- **Cause:** Windows installer detection treats executables named `setup.exe` as installers unless they embed an application manifest declaring the requested execution level. Cargo's test harness and `cargo run --bin setup` produce `setup.exe`, triggering UAC.
- **Solution:** Embed a Windows manifest with `<requestedExecutionLevel level="asInvoker" uiAccess="false" />` from `build.rs` using `winresource`, and set the `setup` bin `test = false` so `cargo test` does not try to execute a setup-named test harness unnecessarily.
- **Discovered in:** Trade Compliance Classification Engine, batch 001, 2026-05-24.
- **Affects:** Windows development environments and Rust binaries named `setup`.
