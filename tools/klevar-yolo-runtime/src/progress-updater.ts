import { readText, writeText } from "./util/fs.js";
import type { Batch } from "./types.js";

export async function tickProgressItems(cwd: string, batch: Batch): Promise<void> {
  const file = `${cwd}/docs/progress.md`;
  let text = await readText(file);
  for (const item of batch.items) {
    const checked = item.raw.replace("- [ ]", "- [x]").replace("- [/ ]", "- [x]");
    if (text.includes(item.raw)) text = text.replace(item.raw, checked);
  }
  await writeText(file, text);
}
