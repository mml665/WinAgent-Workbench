import path from "node:path";

export function normalizeHostPath(input: string): string {
  return path.resolve(input.trim());
}

export function pathComparisonKey(input: string): string {
  const resolved = normalizeHostPath(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInside(parent: string, child: string): boolean {
  const parentKey = pathComparisonKey(parent);
  const childKey = pathComparisonKey(child);
  if (parentKey === childKey) {
    return true;
  }
  const withSeparator = parentKey.endsWith(path.sep)
    ? parentKey
    : `${parentKey}${path.sep}`;
  return childKey.startsWith(withSeparator);
}
