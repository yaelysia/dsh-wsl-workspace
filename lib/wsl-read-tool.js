import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { FsError } from "@deepseek-ai/dsh-fs";
//#region src/shared/read-language.ts
const BY_EXTENSION = new Map(Object.entries({
	ts: "ts mts cts",
	tsx: "tsx",
	js: "js mjs cjs",
	jsx: "jsx",
	sh: "sh bash zsh",
	fish: "fish",
	json: "json jsonc jsonl ndjson ipynb",
	csv: "csv",
	py: "py pyw pyi",
	rb: "rb rake gemspec",
	go: "go",
	rs: "rs",
	java: "java",
	c: "c h",
	cpp: "cc cpp cxx hh hpp hxx",
	cs: "cs",
	kotlin: "kt kts",
	swift: "swift",
	php: "php",
	yaml: "yaml yml",
	toml: "toml",
	ini: "ini conf cfg properties",
	env: "env",
	log: "log",
	diff: "diff patch",
	http: "http",
	md: "md markdown",
	mdx: "mdx",
	rst: "rst",
	tex: "tex sty cls",
	bib: "bib",
	adoc: "adoc",
	html: "html htm xhtml",
	css: "css",
	scss: "scss",
	less: "less",
	sql: "sql",
	xml: "xml xsd xsl xslt plist svg",
	lua: "lua",
	bat: "bat cmd",
	ps1: "ps1 psm1 psd1",
	r: "r",
	jl: "jl",
	dart: "dart",
	scala: "scala",
	clj: "clj cljs edn",
	erl: "erl hrl",
	ex: "ex exs",
	hs: "hs",
	fs: "fs fsi fsx",
	vb: "vb",
	pl: "pl pm",
	v: "v",
	sv: "sv svh",
	graphql: "graphql gql",
	proto: "proto",
	tf: "tf",
	tfvars: "tfvars",
	hcl: "hcl",
	nix: "nix",
	vue: "vue",
	svelte: "svelte",
	make: "makefile mk",
	cmake: "cmake",
	gradle: "gradle",
	groovy: "groovy"
}).flatMap(([language, names]) => names.split(" ").map((name) => [name, language])));
/** Plain text for unknown extensions; both Unix and Windows separators match upstream. */
function readLangHintForPath(path) {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const base = path.slice(slash + 1);
	const dot = base.lastIndexOf(".");
	return dot < 0 ? void 0 : BY_EXTENSION.get(base.slice(dot + 1).toLowerCase());
}
//#endregion
//#region src/host/wsl-read-tool.ts
const inject = [
	"tools",
	"fs",
	"systemPrompt",
	"workingDirectory"
];
const Config = z.object({
	readLimit: z.number().default(2e3),
	readMaxLineLength: z.number().default(2e3),
	readMaxBytes: z.number().default(51200),
	readStreamMinSize: z.number().default(10485760)
});
/** Cordis host event augmentation differs across published type releases.
* Preserve the runtime event shape without changing the DSH observer contract. */
function recordObserved(ctx, target, observation, exec) {
	ctx.emit("fs/observed", target, observation, exec);
}
function readArgs(args, maxLimit) {
	if (args.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string");
	const positive = (value, label) => {
		if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
		return value;
	};
	const offset = args.offset === void 0 ? 1 : positive(args.offset, "offset");
	const limit = args.limit === void 0 ? maxLimit : positive(args.limit, "limit");
	if (limit > maxLimit) throw new Error(`limit must be less than or equal to ${maxLimit}`);
	return {
		filePath: args.file_path,
		offset,
		limit
	};
}
/** Mirrors the bounded, exact-total-line host window, including CRLF and long-line limits. */
async function windowOf(chunks, request, path) {
	const lines = [];
	let totalLines = 0, outputBytes = 0, truncatedByBytes = false, lineBuffer = "";
	const bufferCap = request.maxLineLength + 1;
	const append = (segment) => {
		if (lineBuffer.length < bufferCap) lineBuffer = (lineBuffer + segment).slice(0, bufferCap);
	};
	const flush = () => {
		totalLines++;
		if (!truncatedByBytes && totalLines >= request.offset && lines.length < request.limit) {
			const line = lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer;
			const text = line.length > request.maxLineLength ? `${line.substring(0, request.maxLineLength)}... (line truncated to ${request.maxLineLength} chars)` : line;
			const bytes = Buffer.byteLength(text, "utf8") + (lines.length ? 1 : 0);
			if (outputBytes + bytes > request.maxBytes) truncatedByBytes = true;
			else {
				outputBytes += bytes;
				lines.push({
					number: totalLines,
					text
				});
			}
		}
		lineBuffer = "";
	};
	for await (const chunk of chunks) {
		let begin = 0, end;
		while ((end = chunk.indexOf("\n", begin)) !== -1) {
			append(chunk.slice(begin, end));
			flush();
			begin = end + 1;
		}
		append(chunk.slice(begin));
	}
	if (lineBuffer.length) flush();
	if (!truncatedByBytes && request.offset > totalLines && !(totalLines === 0 && request.offset === 1)) throw new FsError(`offset ${request.offset} is out of range for "${path}" (${totalLines} lines)`, "FS_NOT_FOUND");
	return {
		lines,
		totalLines,
		truncatedByBytes
	};
}
function formattedRead(value, truncatedByBytes) {
	const end = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1);
	const footer = truncatedByBytes ? `(Output capped. Showing lines ${value.offset}-${end}. Use offset=${end + 1} to continue.)` : end < value.totalLines ? `(Showing lines ${value.offset}-${end} of ${value.totalLines}. Use offset=${end + 1} to continue.)` : `(End of file - total ${value.totalLines} lines)`;
	const body = value.lines.length ? `${value.lines.map((line) => `${line.number}: ${line.text}`).join("\n")}\n\n${footer}` : footer;
	return `<path>${value.path}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
}
function readMeta(meta) {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return void 0;
	const { path, offset, lines, totalLines, lang } = meta;
	if (typeof path !== "string" || !Number.isInteger(offset) || offset < 1 || !Number.isInteger(totalLines) || totalLines < 0 || !Array.isArray(lines) || lang !== void 0 && typeof lang !== "string") return void 0;
	let previous = offset - 1;
	for (const line of lines) {
		if (!line || typeof line !== "object" || !Number.isInteger(line.number) || line.number <= previous || line.number > totalLines || typeof line.text !== "string") return void 0;
		previous = line.number;
	}
	return {
		path,
		offset,
		lines,
		totalLines,
		...lang === void 0 ? {} : { lang }
	};
}
function apply(ctx, config = {}) {
	const caps = {
		readLimit: 2e3,
		readMaxLineLength: 2e3,
		readMaxBytes: 51200,
		readStreamMinSize: 10485760,
		...config
	};
	for (const [key, value] of Object.entries(caps)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`wsl-read: invalid ${key}`);
	const tools = ctx.get("tools");
	if (tools === void 0) return;
	const prompt = ctx.get("systemPrompt");
	prompt?.section({
		name: "tool:read",
		order: prompt.getSectionOrder("TOOL_READ"),
		text: ({ scope }) => {
			return ctx.get("tools")?.get?.("read", scope) === void 0 ? "" : "Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files.";
		}
	});
	tools.register(defineTool({
		name: "read",
		description: "Read a UTF-8 text file and return line-numbered content.",
		parameters: {
			file_path: {
				type: "string",
				required: true,
				description: "Path to read, resolved by the filesystem backend."
			},
			offset: {
				type: "number",
				description: "1-based first line to return. Defaults to 1."
			},
			limit: {
				type: "number",
				description: `Maximum number of lines to return. Defaults to ${caps.readLimit}.`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true
					},
					offset: {
						type: "integer",
						required: true
					},
					lines: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								number: {
									type: "integer",
									required: true
								},
								text: {
									type: "string",
									required: true
								}
							}
						}
					},
					totalLines: {
						type: "integer",
						required: true
					}
				}
			},
			render: (args, value) => {
				const input = readArgs(args, caps.readLimit);
				const end = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1);
				return [{
					type: "text",
					text: formattedRead(value, value.lines.length < input.limit && end < value.totalLines)
				}];
			},
			presentationMeta: (_args, value) => {
				const lang = readLangHintForPath(value.path);
				return {
					path: value.path,
					offset: value.offset,
					lines: value.lines.map(({ number, text }) => ({
						number,
						text
					})),
					totalLines: value.totalLines,
					...lang === void 0 ? {} : { lang }
				};
			}
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const input = readArgs(args, caps.readLimit);
			const fs = ctx.get("fs");
			if (fs === void 0) throw new Error("wsl-read: this world has no filesystem service");
			const directory = ctx.get("workingDirectory");
			const cwd = exec.agent === void 0 ? void 0 : await directory?.ensure(exec.agent, exec.signal);
			const snapshot = await fs.readSnapshot(input.filePath, {
				...cwd === void 0 ? {} : { cwd },
				signal: exec.signal,
				streamMinSize: caps.readStreamMinSize
			});
			const { target, info } = snapshot;
			if (!info) {
				recordObserved(ctx, target, { kind: "absent" }, exec);
				throw new FsError(`cannot read "${target.displayPath}": not found`, "FS_NOT_FOUND");
			}
			if (info.type !== "file") throw new FsError(`cannot read "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
			const window = await windowOf(info.size === void 0 || info.size >= caps.readStreamMinSize ? await fs.streamText(target, exec.signal) : [snapshot.text], {
				offset: input.offset,
				limit: input.limit,
				maxLineLength: caps.readMaxLineLength,
				maxBytes: caps.readMaxBytes
			}, target.displayPath);
			const value = {
				path: fs.processPath(target),
				offset: input.offset,
				lines: window.lines,
				totalLines: window.totalLines
			};
			recordObserved(ctx, target, {
				kind: "present",
				version: info.version
			}, exec);
			return value;
		},
		presentResult(_args, result) {
			if (result.isError) return void 0;
			const meta = readMeta(result.meta);
			if (!meta) return void 0;
			const text = result.content.length === 1 && result.content[0]?.type === "text" ? result.content[0].text : void 0;
			const body = text === void 0 ? void 0 : /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1];
			if (body === void 0) return void 0;
			return {
				card: "read",
				path: meta.path,
				offset: meta.offset,
				lines: meta.lines,
				totalLines: meta.totalLines,
				...meta.lang === void 0 ? {} : { lang: meta.lang },
				content: [{
					type: "text",
					text: body
				}]
			};
		},
		presentCall(args) {
			const { offset, limit } = args;
			const suffix = limit !== void 0 && limit > 0 ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})` : offset !== void 0 ? ` (from line ${offset})` : "";
			return {
				card: "generic",
				title: `Read ${args.file_path}${suffix}`,
				kind: "read",
				locations: [{
					path: args.file_path,
					line: offset ?? 1
				}]
			};
		}
	}));
}
var wsl_read_tool_default = {
	apply,
	inject,
	Config
};
//#endregion
export { Config, apply, wsl_read_tool_default as default, inject };

//# sourceMappingURL=wsl-read-tool.js.map