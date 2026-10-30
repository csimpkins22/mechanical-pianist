// Converts a .glb into a self-contained glTF JSON (binary chunk embedded as a
// data URI), for hosts that serve .json but not .glb. The app falls back to
// these automatically when a .glb cannot be fetched.
//   node tools/glb-to-json.cjs in.glb out.json
const fs = require('fs');
const [, , inp, out] = process.argv;
const b = fs.readFileSync(inp);
if (b.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
let off = 12;
let json = null;
let bin = null;
while (off < b.length) {
  const len = b.readUInt32LE(off);
  const type = b.toString('ascii', off + 4, off + 8);
  const data = b.subarray(off + 8, off + 8 + len);
  if (type === 'JSON') json = JSON.parse(data.toString('utf8'));
  else if (type === 'BIN\0') bin = data;
  off += 8 + len;
}
json.buffers[0].uri = 'data:application/octet-stream;base64,' + bin.toString('base64');
fs.writeFileSync(out, JSON.stringify(json));
console.log(`${out}: ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
