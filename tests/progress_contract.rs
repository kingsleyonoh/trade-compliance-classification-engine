use std::collections::BTreeMap;

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
    let progress =
        std::fs::read_to_string("docs/progress.md").expect("docs/progress.md is readable");
    let mut malformed = Vec::new();
    let mut closeouts_by_phase: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let mut current_phase = String::from("Unphased");
    let mut in_fence = false;

    for (index, line) in progress.lines().enumerate() {
        let line_number = index + 1;
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(phase) = line.strip_prefix("## Phase") {
            current_phase = format!("Phase{}", phase.trim_end());
        }
        if !line.starts_with("- [") {
            continue;
        }

        let has_known_tag = KNOWN_TAGS.iter().any(|tag| {
            line.starts_with(&format!("- [ ] {tag} "))
                || line.starts_with(&format!("- [x] {tag} "))
                || line.starts_with(&format!("- [/] {tag} "))
        });
        if !has_known_tag {
            malformed.push(line_number);
            continue;
        }

        let lower = line.to_ascii_lowercase();
        if lower.contains("phase ") && lower.contains("close-out") {
            closeouts_by_phase
                .entry(current_phase.clone())
                .or_default()
                .push(line_number);
        }
    }

    let multiple_closeouts: Vec<_> = closeouts_by_phase
        .into_iter()
        .filter(|(_, lines)| lines.len() > 1)
        .collect();
    let mut failures = Vec::new();
    if !malformed.is_empty() {
        failures.push(format!(
            "progress checklist lines must include a known runtime tag; malformed lines: {malformed:?}"
        ));
    }
    if !multiple_closeouts.is_empty() {
        failures.push(format!(
            "each phase may have only one close-out audit item; duplicates: {multiple_closeouts:?}"
        ));
    }

    assert!(failures.is_empty(), "{}", failures.join("; "));
}
