import { spawn, type IPty } from "node-pty";

export class TerminalService {
  private readonly terminals = new Map<string, IPty>();

  constructor(private readonly emit: (event: { id: string; data?: string; exitCode?: number }) => void) {}

  create(id: string, cwd: string, env: Record<string, string>, cols = 80, rows = 24) {
    if (this.terminals.has(id)) throw new Error("终端已存在");
    const shell = env.SHELL || "/bin/zsh";
    const terminal = spawn(shell, ["-l"], { name: "xterm-256color", cwd, env, cols: Math.max(2, Math.min(1000, Math.floor(cols) || 80)), rows: Math.max(1, Math.min(1000, Math.floor(rows) || 24)) });
    this.terminals.set(id, terminal);
    terminal.onData(data => this.emit({ id, data }));
    terminal.onExit(({ exitCode }) => {
      if (this.terminals.get(id) !== terminal) return;
      this.terminals.delete(id);
      this.emit({ id, exitCode });
    });
    return shell.split("/").at(-1) || shell;
  }

  write(id: string, data: string) { this.terminals.get(id)?.write(data); }
  resize(id: string, cols: number, rows: number) {
    if (Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && rows >= 1 && cols <= 1000 && rows <= 1000)
      this.terminals.get(id)?.resize(cols, rows);
  }
  close(id: string) {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    this.terminals.delete(id);
    terminal.kill();
  }
  dispose() { for (const id of this.terminals.keys()) this.close(id); }
}
