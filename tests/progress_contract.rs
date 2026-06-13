use std::collections::BTreeMap;

#[derive(Debug, Default)]
struct ProgressScan {
    malformed_lines: Vec<usize>,
    closeouts_by_phase: BTreeMap<String, Vec<usize>>,
}

const KNOWN_TAGS: &[&str] = &[
    "[SETUP]",
    "[DATA]",
    "[API]",
    "[JOB]",
    "[INTEGRATION]",
    "[UI]",
    "[MATRIX]",
    "[AUDIT]",
    "[FEATURE]",
    "[BUG]",
    "[FIX]",
];

#[test]
fn progress_checklist_items_are_structured_runtime_items() {
    let Ok(progress) = std::fs::read_to_string("docs/progress.md") else {
        // docs/progress.md is an internal development ledger stripped from public releases.
        return;
    };
    let scan = scan_progress_items(&progress);
    let failures = progress_scan_failures(scan);

    assert!(failures.is_empty(), "{}", failures.join("; "));
}

fn scan_progress_items(progress: &str) -> ProgressScan {
    let mut scan = ProgressScan::default();
    let mut current_phase = String::from("Unphased");
    let mut in_fence = false;

    for (index, line) in progress.lines().enumerate() {
        if should_skip_progress_line(line, &mut in_fence) {
            continue;
        }
        if let Some(phase) = line.strip_prefix("## Phase") {
            current_phase = format!("Phase{}", phase.trim_end());
        }
        if line.starts_with("- [") {
            scan_progress_item(line, index + 1, &current_phase, &mut scan);
        }
    }

    scan
}

fn should_skip_progress_line(line: &str, in_fence: &mut bool) -> bool {
    if line.trim_start().starts_with("```") {
        *in_fence = !*in_fence;
        return true;
    }
    *in_fence
}

fn scan_progress_item(
    line: &str,
    line_number: usize,
    current_phase: &str,
    scan: &mut ProgressScan,
) {
    if !has_known_runtime_tag(line) {
        scan.malformed_lines.push(line_number);
        return;
    }

    let lower = line.to_ascii_lowercase();
    if lower.contains("phase ") && lower.contains("close-out") {
        scan.closeouts_by_phase
            .entry(current_phase.to_owned())
            .or_default()
            .push(line_number);
    }
}

fn has_known_runtime_tag(line: &str) -> bool {
    KNOWN_TAGS.iter().any(|tag| {
        line.starts_with(&format!("- [ ] {tag} "))
            || line.starts_with(&format!("- [x] {tag} "))
            || line.starts_with(&format!("- [/] {tag} "))
    })
}

fn progress_scan_failures(scan: ProgressScan) -> Vec<String> {
    let mut failures = Vec::new();
    push_malformed_progress_failures(&mut failures, &scan.malformed_lines);
    push_duplicate_closeout_failures(&mut failures, scan.closeouts_by_phase);
    failures
}

fn push_malformed_progress_failures(failures: &mut Vec<String>, malformed_lines: &[usize]) {
    if !malformed_lines.is_empty() {
        failures.push(format!(
            "progress checklist lines must include a known runtime tag; malformed lines: {malformed_lines:?}"
        ));
    }
}

fn push_duplicate_closeout_failures(
    failures: &mut Vec<String>,
    closeouts_by_phase: BTreeMap<String, Vec<usize>>,
) {
    let multiple_closeouts: Vec<_> = closeouts_by_phase
        .into_iter()
        .filter(|(_, lines)| lines.len() > 1)
        .collect();
    if !multiple_closeouts.is_empty() {
        failures.push(format!(
            "each phase may have only one close-out audit item; duplicates: {multiple_closeouts:?}"
        ));
    }
}
