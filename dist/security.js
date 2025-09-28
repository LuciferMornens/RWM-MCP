import { resolve, sep } from "node:path";
export function safeJoin(root, rel) {
    const p = resolve(root, rel);
    if (!p.startsWith(resolve(root) + sep) && p !== resolve(root)) {
        throw new Error(`Path escapes workspace root: ${rel}`);
    }
    return p;
}
