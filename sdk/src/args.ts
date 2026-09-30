// Hand-rolled argument parsing for the CLI. No dependencies.

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface FlagSpec {
  /** Flags that take a value: --text "hello" or --text=hello. */
  value?: string[];
  /** Flags that take a value and may be repeated: --media a --media b. */
  repeat?: string[];
  /** Flags with no value: --json. */
  bool?: string[];
}

export interface ParsedArgs {
  positional: string[];
  /** Value flags by name (last one wins). */
  values: Record<string, string>;
  /** Repeatable flags by name, in the order given. */
  lists: Record<string, string[]>;
  /** Boolean flags that were present. */
  bools: Set<string>;
}

/** Flags every command accepts. */
export const GLOBAL_SPEC: Required<FlagSpec> = { value: ["key", "base-url"], repeat: [], bool: ["json", "help"] };

const looksLikeFlag = (token: string) => /^--[a-zA-Z]/.test(token);

export function parseArgs(argv: string[], spec: FlagSpec = {}): ParsedArgs {
  const valueFlags = new Set([...GLOBAL_SPEC.value, ...(spec.value ?? [])]);
  const repeatFlags = new Set(spec.repeat ?? []);
  const boolFlags = new Set([...GLOBAL_SPEC.bool, ...(spec.bool ?? [])]);
  const out: ParsedArgs = { positional: [], values: {}, lists: {}, bools: new Set() };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "-h") {
      out.bools.add("help");
      continue;
    }
    if (token === "--") {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (!looksLikeFlag(token)) {
      out.positional.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq === -1 ? undefined : eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);

    if (boolFlags.has(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} does not take a value.`);
      out.bools.add(name);
      continue;
    }
    if (valueFlags.has(name) || repeatFlags.has(name)) {
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || looksLikeFlag(next)) throw new UsageError(`--${name} needs a value.`);
        value = next;
        i++;
      }
      if (repeatFlags.has(name)) (out.lists[name] ??= []).push(value);
      else out.values[name] = value;
      continue;
    }
    throw new UsageError(`Unknown option --${name}.`);
  }
  return out;
}
