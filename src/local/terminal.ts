import { AppError } from "../domain/errors.js";

export function promptHidden(
  prompt: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): Promise<string> {
  if (!input.isTTY || !output.isTTY || !input.setRawMode)
    throw new AppError("SETUP_REQUIRED");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw ?? false;
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.setRawMode(wasRaw);
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onEnd = () => finish(new AppError("SETUP_REQUIRED"));
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003" || character === "\u0004") {
          finish(new AppError("SETUP_REQUIRED"));
          return;
        }
        if (character === "\b" || character === "\u007f") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (
          !/\p{Cc}/u.test(character) &&
          Buffer.byteLength(value + character, "utf8") <= 8192
        )
          value += character;
      }
    };
    output.write(prompt);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onData);
    input.on("end", onEnd);
  });
}
