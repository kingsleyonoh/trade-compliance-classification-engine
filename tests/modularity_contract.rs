use std::fs;
use std::path::{Path, PathBuf};

const LINE_LIMIT: usize = 250;
const FUNCTION_LIMIT: usize = 40;

#[test]
fn phase_one_rust_files_respect_modularity_limits() {
    let files = rust_files_under(["src"]);
    let mut failures = Vec::new();

    for file in files {
        let source = fs::read_to_string(&file).expect("Rust file should be readable");
        check_file_size(&file, &source, &mut failures);
        check_function_lengths(&file, &source, &mut failures);
    }

    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn rust_files_under<const N: usize>(roots: [&str; N]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for root in roots {
        collect_rust_files(Path::new(root), &mut files);
    }
    files.sort();
    files
}

fn collect_rust_files(path: &Path, files: &mut Vec<PathBuf>) {
    if path.is_file() {
        if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path.to_path_buf());
        }
        return;
    }

    for entry in fs::read_dir(path).expect("source directory should be readable") {
        collect_rust_files(
            &entry.expect("directory entry should be readable").path(),
            files,
        );
    }
}

fn check_file_size(path: &Path, source: &str, failures: &mut Vec<String>) {
    let lines = source.lines().count();
    if lines > LINE_LIMIT {
        failures.push(format!(
            "FILE_SIZE {} {} lines (limit {})",
            path.display(),
            lines,
            LINE_LIMIT
        ));
    }
}

fn check_function_lengths(path: &Path, source: &str, failures: &mut Vec<String>) {
    let mut scanner = FunctionScanner::default();
    for (index, line) in source.lines().enumerate() {
        scanner.observe_line(path, index + 1, line, failures);
    }
}

#[derive(Default)]
struct FunctionScanner {
    start_line: usize,
    signature: String,
    brace_depth: i32,
    saw_opening_brace: bool,
}

impl FunctionScanner {
    fn observe_line(
        &mut self,
        path: &Path,
        line_number: usize,
        line: &str,
        failures: &mut Vec<String>,
    ) {
        if self.start_line == 0 && is_function_signature(line) {
            self.start_line = line_number;
            self.signature = line.trim().to_owned();
        }

        if self.start_line == 0 {
            return;
        }

        let opens = line.matches('{').count() as i32;
        self.saw_opening_brace |= opens > 0;
        self.brace_depth += opens;
        self.brace_depth -= line.matches('}').count() as i32;

        if self.saw_opening_brace && self.brace_depth <= 0 {
            self.finish_function(path, line_number, failures);
        }
    }

    fn finish_function(&mut self, path: &Path, end_line: usize, failures: &mut Vec<String>) {
        let length = end_line - self.start_line + 1;
        if length > FUNCTION_LIMIT {
            failures.push(format!(
                "FUNCTION_LENGTH {}:{}-{} {} lines (limit {}) :: {}",
                path.display(),
                self.start_line,
                end_line,
                length,
                FUNCTION_LIMIT,
                self.signature
            ));
        }
        *self = Self::default();
    }
}

fn is_function_signature(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("fn ")
        || trimmed.starts_with("pub fn ")
        || trimmed.starts_with("async fn ")
        || trimmed.starts_with("pub async fn ")
}
