[Reading 46 lines from start (total: 46 lines, 0 remaining)]

import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { EventEmitter } from "node:events";

export interface DownloadInfo { name:string; size:number; mtime:number; status:"completed"; }

export class DownloadManager extends EventEmitter {
  readonly root: string;
  readonly completed: string;
  readonly temporary: string;
  constructor(root = process.env.BROWSERFACE_DATA_ROOT
    ? join(process.env.BROWSERFACE_DATA_ROOT, "Downloads")
    : "/mnt/scratch/Browserface/Downloads") {
    super();
    this.root = resolve(root);
    this.completed = join(this.root, "completed");
    this.temporary = join(this.root, "temporary");
  }
  async init() {
    await mkdir(this.completed, { recursive: true });
    await mkdir(this.temporary, { recursive: true });
  }
  async list(): Promise<DownloadInfo[]> {
    const entries = await readdir(this.completed, { withFileTypes: true });
    const out: DownloadInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const s = await stat(join(this.completed, entry.name));
      out.push({ name: entry.name, size: s.size, mtime: s.mtimeMs, status: "completed" });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }
  pathFor(name: string) {
    const clean = basename(name);
    if (!clean || clean !== name || clean === "." || clean === "..") throw new Error("invalid filename");
    return join(this.completed, clean);
  }
  stream(name: string) {
    return createReadStream(this.pathFor(name));
  }
  async remove(name: string) {
    await unlink(this.pathFor(name));
    this.emit("changed");
  }
}

[executed on device: ip-172-31-44-71 (13ee5edb-ae63-40e5-b176-f056db72d14f)]