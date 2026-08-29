import { createInterface } from "node:readline";

/**
 * Reads a passphrase without leaving it where other people can read it.
 *
 * Order of preference: the terminal (echo off), then `CAPSULE_PASSPHRASE`, and
 * only then `--passphrase`, which ends up in shell history and in the process
 * list where any other user on the machine can see it. The flag exists for
 * scripting, and the CLI says what it costs.
 */
export interface ReadPassphraseOptions {
  confirm?: boolean;
  prompt?: string;
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stderr;
    output.write(prompt);

    if (!input.isTTY) {
      const reader = createInterface({ input });
      reader.once("line", (line) => {
        reader.close();
        output.write("\n");
        resolve(line);
      });
      reader.once("error", reject);
      return;
    }

    let value = "";
    const wasRaw = input.isRaw ?? false;
    input.setRawMode(true);
    input.resume();
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          cleanup();
          reject(new Error("Cancelled"));
          return;
        }
        if (byte === 0x0d || byte === 0x0a) {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };
    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
    };
    input.on("data", onData);
  });
}

export async function readPassphrase(
  provided: string | undefined,
  options: ReadPassphraseOptions = {},
): Promise<string> {
  if (provided) return provided;
  const fromEnvironment = process.env.CAPSULE_PASSPHRASE;
  if (fromEnvironment) return fromEnvironment;

  const passphrase = await promptHidden(options.prompt ?? "Passphrase: ");
  if (!passphrase) throw new Error("No passphrase was entered");
  if (options.confirm) {
    const again = await promptHidden("Repeat the passphrase: ");
    if (again !== passphrase) throw new Error("The passphrases do not match");
  }
  return passphrase;
}
