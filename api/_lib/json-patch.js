// [PR1] A small RFC 6902 applier for the "This isn't quite right"
// interpreter. The model returns `changes` as JSON Patch operations against
// the strategy JSON; this applies them to a deep copy and returns the copy,
// so the caller can diff before/after and offer undo.
//
// Supports add / replace / remove / move / copy / test. Paths use the
// standard "/pillars/0/share" form with ~0 ~1 escapes. Throws on a bad path
// so a malformed patch is rejected whole rather than half-applied.

function unescape(seg) { return seg.replace(/~1/g, "/").replace(/~0/g, "~"); }

function parsePath(path) {
  if (path === "") return [];
  if (typeof path !== "string" || path[0] !== "/") throw new Error("bad path " + path);
  return path.slice(1).split("/").map(unescape);
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function getAt(root, segs) {
  let cur = root;
  for (const s of segs) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(s)] : cur[s];
  }
  return cur;
}

function parentOf(root, segs) {
  if (!segs.length) throw new Error("cannot operate on root");
  const parent = getAt(root, segs.slice(0, -1));
  if (parent == null || typeof parent !== "object") throw new Error("missing parent for /" + segs.join("/"));
  return { parent, key: segs[segs.length - 1] };
}

function add(root, segs, value) {
  const { parent, key } = parentOf(root, segs);
  if (Array.isArray(parent)) {
    const idx = key === "-" ? parent.length : Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) throw new Error("bad index " + key);
    parent.splice(idx, 0, value);
  } else {
    parent[key] = value;
  }
}

function remove(root, segs) {
  const { parent, key } = parentOf(root, segs);
  if (Array.isArray(parent)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) throw new Error("bad index " + key);
    return parent.splice(idx, 1)[0];
  }
  if (!(key in parent)) throw new Error("missing key " + key);
  const v = parent[key];
  delete parent[key];
  return v;
}

export function applyPatch(doc, ops) {
  const root = clone(doc);
  if (!Array.isArray(ops)) throw new Error("ops must be an array");
  for (const op of ops) {
    if (!op || typeof op.op !== "string") throw new Error("bad op");
    const segs = parsePath(op.path);
    switch (op.op) {
      case "add":     add(root, segs, clone(op.value)); break;
      case "replace": {
        if (getAt(root, segs) === undefined) throw new Error("replace on missing " + op.path);
        remove(root, segs); add(root, segs, clone(op.value)); break;
      }
      case "remove":  remove(root, segs); break;
      case "move": {
        const from = parsePath(op.from);
        const v = remove(root, from); add(root, segs, v); break;
      }
      case "copy": {
        const v = clone(getAt(root, parsePath(op.from)));
        if (v === undefined) throw new Error("copy from missing " + op.from);
        add(root, segs, v); break;
      }
      case "test": {
        if (JSON.stringify(getAt(root, segs)) !== JSON.stringify(op.value)) throw new Error("test failed at " + op.path);
        break;
      }
      default: throw new Error("unsupported op " + op.op);
    }
  }
  return root;
}

// Flat before/after list for the diff banner: [{ path, before, after }] for
// every leaf that changed. Arrays of primitives are compared whole.
export function diffStrategies(before, after, prefix) {
  const out = [];
  const pre = prefix || "";
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const a = before ? before[k] : undefined;
    const b = after ? after[k] : undefined;
    const path = pre + "/" + k;
    const bothObj = a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b);
    const bothArrObj = Array.isArray(a) && Array.isArray(b) && a.concat(b).every(x => x && typeof x === "object");
    if (bothObj) out.push(...diffStrategies(a, b, path));
    else if (bothArrObj) {
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) {
        if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) out.push(...diffStrategies(a[i] || {}, b[i] || {}, path + "/" + i));
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, before: a, after: b });
  }
  return out;
}
