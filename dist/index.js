import { existsSync, readFileSync, readdirSync, readlinkSync, statSync, unlinkSync } from "node:fs";
import { basename as external_node_path_basename, dirname, isAbsolute, join as external_node_path_join } from "node:path";
import schemastery from "schemastery";
import { glob as promises_glob, mkdir, open as promises_open, readFile, readdir as promises_readdir, realpath, rename, rm, stat as promises_stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { constants, zstdCompress, zstdDecompress } from "node:zlib";
import { randomUUID as external_node_crypto_randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { AgentSideConnection, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import { Socket, createServer } from "node:net";
var __webpack_require__ = {};
(()=>{
    __webpack_require__.d = (exports, getters, values)=>{
        var define = (defs, kind)=>{
            for(var key in defs)if (__webpack_require__.o(defs, key) && !__webpack_require__.o(exports, key)) Object.defineProperty(exports, key, {
                enumerable: true,
                [kind]: defs[key]
            });
        };
        define(getters, "get");
        define(values, "value");
    };
})();
(()=>{
    __webpack_require__.o = (obj, prop)=>Object.prototype.hasOwnProperty.call(obj, prop);
})();
(()=>{
    __webpack_require__.r = (exports)=>{
        if ("u" > typeof Symbol && Symbol.toStringTag) Object.defineProperty(exports, Symbol.toStringTag, {
            value: 'Module'
        });
        Object.defineProperty(exports, '__esModule', {
            value: true
        });
    };
})();
var repair_namespaceObject = {};
__webpack_require__.r(repair_namespaceObject);
__webpack_require__.d(repair_namespaceObject, {
    P: ()=>detectInterleavedArtifact,
    t: ()=>repairInterleavedArtifact,
    repairInterleavedLog: ()=>repair_repairInterleavedLog
});
const ZSTD_MAGIC = 0xfd2fb528;
const MAX_SCAN_BYTES = 8388608;
const MAX_FRAMES = 32;
const zstdDecompressAsync = promisify(zstdDecompress);
function first_prompt_scanZstdFrames(buffer, maxFrames) {
    const frames = [];
    let offset = 0;
    while(offset < buffer.length && frames.length < maxFrames){
        const start = offset;
        if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
        offset += 4;
        if (offset === buffer.length) break;
        const descriptor = buffer.readUInt8(offset);
        offset += 1;
        if ((0x18 & descriptor) !== 0) break;
        const contentSizeFlag = descriptor >>> 6;
        const singleSegment = (0x20 & descriptor) !== 0;
        const checksum = (0x04 & descriptor) !== 0;
        const dictionaryFlag = 0x03 & descriptor;
        const dictionaryBytes = 3 === dictionaryFlag ? 4 : dictionaryFlag;
        const contentSizeBytes = 0 === contentSizeFlag ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
        const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
        if (buffer.length - offset < remainingHeaderBytes) break;
        offset += remainingHeaderBytes;
        for(;;){
            if (buffer.length - offset < 3) return frames;
            const blockHeader = buffer.readUIntLE(offset, 3);
            offset += 3;
            const lastBlock = (1 & blockHeader) !== 0;
            const blockType = blockHeader >>> 1 & 0x03;
            const blockSize = blockHeader >>> 3;
            if (0x03 === blockType) return frames;
            const payloadBytes = 0x01 === blockType ? 1 : blockSize;
            if (buffer.length - offset < payloadBytes) return frames;
            offset += payloadBytes;
            if (lastBlock) break;
        }
        if (checksum) {
            if (buffer.length - offset < 4) return frames;
            offset += 4;
        }
        frames.push({
            start,
            end: offset
        });
    }
    return frames;
}
function encodeSegment(raw) {
    if (0 === raw.length) return '~0020';
    if ('.' === raw) return '~002E';
    if ('..' === raw) return '~002E~002E';
    let out = '';
    for(let i = 0; i < raw.length; i++){
        const code = raw.charCodeAt(i);
        const ch = String.fromCharCode(code);
        if ('~' !== ch && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
        else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
    }
    return out;
}
function projectKey(cwd) {
    let readable = '';
    let separatorRun = false;
    for(let i = 0; i < cwd.length; i++){
        const code = cwd.charCodeAt(i);
        const ch = String.fromCharCode(code);
        if ('/' === ch || '\\' === ch || ':' === ch) {
            if (!separatorRun) readable += '-';
            separatorRun = true;
        } else if ('~' !== ch && /^[A-Za-z0-9._-]$/.test(ch)) {
            readable += ch;
            separatorRun = false;
        } else {
            readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
            separatorRun = false;
        }
    }
    const slug = readable.replace(/^-+/, '') || 'root';
    return `--${slug.slice(0, 251)}--`;
}
function sessionLogPath(root, cwd, id) {
    const dir = void 0 === cwd ? external_node_path_join(root, '_no-cwd') : external_node_path_join(root, projectKey(cwd));
    return external_node_path_join(dir, encodeSegment(id), 'session.jsonl.zstd');
}
async function sessionTitleFromLog(root, header) {
    const path = sessionLogPath(root, header.cwd, String(header.id));
    let handle;
    try {
        handle = await promises_open(path, 'r');
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(Math.min(MAX_SCAN_BYTES, 1048576)), 0, Math.min(MAX_SCAN_BYTES, 1048576), 0);
        let data = buffer.subarray(0, bytesRead);
        let frames = first_prompt_scanZstdFrames(data, MAX_FRAMES);
        let grown = data.length;
        while(0 === frames.length && grown < MAX_SCAN_BYTES){
            const chunk = Buffer.alloc(Math.min(65536, MAX_SCAN_BYTES - grown));
            const { bytesRead: more } = await handle.read(chunk, 0, chunk.length, grown);
            if (0 === more) break;
            data = Buffer.concat([
                data,
                chunk.subarray(0, more)
            ]);
            grown += more;
            frames = first_prompt_scanZstdFrames(data, MAX_FRAMES);
        }
        let title;
        for (const frame of frames){
            let text;
            try {
                text = (await zstdDecompressAsync(data.subarray(frame.start, frame.end))).toString('utf8');
            } catch  {
                continue;
            }
            for (const line of text.split('\n')){
                if (0 === line.length) continue;
                let event;
                try {
                    event = JSON.parse(line);
                } catch  {
                    continue;
                }
                if (event?.type !== 'session/title') continue;
                const candidate = event.data?.title;
                if ('string' == typeof candidate && candidate.trim().length > 0) title = candidate;
            }
        }
        return title;
    } catch  {
        return;
    } finally{
        await handle?.close().catch(()=>{});
    }
}
async function firstUserPromptFromLog(root, header) {
    const path = sessionLogPath(root, header.cwd, String(header.id));
    let handle;
    try {
        handle = await promises_open(path, 'r');
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(Math.min(MAX_SCAN_BYTES, 1048576)), 0, Math.min(MAX_SCAN_BYTES, 1048576), 0);
        let data = buffer.subarray(0, bytesRead);
        let frames = first_prompt_scanZstdFrames(data, MAX_FRAMES);
        let grown = data.length;
        while(0 === frames.length && grown < MAX_SCAN_BYTES){
            const chunk = Buffer.alloc(Math.min(65536, MAX_SCAN_BYTES - grown));
            const { bytesRead: more } = await handle.read(chunk, 0, chunk.length, grown);
            if (0 === more) break;
            data = Buffer.concat([
                data,
                chunk.subarray(0, more)
            ]);
            grown += more;
            frames = first_prompt_scanZstdFrames(data, MAX_FRAMES);
        }
        for (const frame of frames){
            let text;
            try {
                text = (await zstdDecompressAsync(data.subarray(frame.start, frame.end))).toString('utf8');
            } catch  {
                continue;
            }
            for (const line of text.split('\n')){
                if (0 === line.length) continue;
                let event;
                try {
                    event = JSON.parse(line);
                } catch  {
                    continue;
                }
                if (event?.type !== 'user/message') continue;
                const blocks = event.data?.content ?? [];
                const prompt = blocks.filter((block)=>block?.type === 'text' && 'string' == typeof block.text).map((block)=>block.text).join('').trim();
                if (prompt.length > 0) return prompt;
            }
        }
        return;
    } catch  {
        return;
    } finally{
        await handle?.close().catch(()=>{});
    }
}
const repair_zstdDecompressAsync = promisify(zstdDecompress);
const zstdCompressAsync = promisify(zstdCompress);
async function detectInterleavedArtifact(path) {
    const buf = await readFile(path);
    const frames = first_prompt_scanZstdFrames(buf, 1000000);
    const { decodeStorageRecord } = await import("@deepseek-ai/dsh-session");
    const seen = new Set();
    for (const frame of frames){
        let text;
        try {
            text = (await repair_zstdDecompressAsync(buf.subarray(frame.start, frame.end))).toString('utf8');
        } catch  {
            continue;
        }
        for (const line of text.split('\n')){
            if (0 === line.length) continue;
            let record;
            try {
                record = JSON.parse(line);
            } catch  {
                continue;
            }
            for (const event of decodeStorageRecord(record))if ('number' == typeof event.seq) {
                if (seen.has(event.seq)) return true;
                seen.add(event.seq);
            }
        }
    }
    return false;
}
async function repairInterleavedArtifact(path) {
    const buf = await readFile(path);
    const frames = first_prompt_scanZstdFrames(buf, 1000000);
    const { decodeStorageRecord } = await import("@deepseek-ai/dsh-session");
    const lastSeen = new Map();
    let header;
    for (const frame of frames){
        let text;
        try {
            text = (await repair_zstdDecompressAsync(buf.subarray(frame.start, frame.end))).toString('utf8');
        } catch  {
            continue;
        }
        for (const line of text.split('\n')){
            if (0 === line.length) continue;
            let record;
            try {
                record = JSON.parse(line);
            } catch  {
                continue;
            }
            if ('object' == typeof record && null !== record && 'session' === record.type) {
                if (void 0 === header) header = line;
                continue;
            }
            for (const event of decodeStorageRecord(record))if ('number' == typeof event.seq) lastSeen.set(event.seq, JSON.stringify(event));
        }
    }
    if (void 0 === header) return false;
    const seqs = [
        ...lastSeen.keys()
    ].sort((a, b)=>a - b);
    let previous;
    for (const seq of seqs){
        if (void 0 !== previous && seq !== previous + 1) return false;
        previous = seq;
    }
    const checksum = {
        params: {
            [constants.ZSTD_c_checksumFlag]: 1
        }
    };
    const frame = (lines)=>zstdCompressAsync(Buffer.from(`${lines.join('\n')}\n`, 'utf8'), checksum);
    const events = seqs.map((seq)=>lastSeen.get(seq));
    const batch = 2000;
    const parts = [
        await frame([
            header
        ])
    ];
    for(let i = 0; i < events.length; i += batch)parts.push(await frame(events.slice(i, i + batch)));
    await writeFile(path, Buffer.concat(parts));
    return true;
}
async function repair_repairInterleavedLog(root, sessionId) {
    const id = encodeSegment(String(sessionId));
    try {
        const { glob } = await import("node:fs/promises");
        const candidates = [];
        for await (const path of glob(external_node_path_join(root, '*', id, 'session.jsonl.zstd')))candidates.push(path);
        candidates.sort();
        const path = candidates.at(-1);
        if (void 0 === path) return false;
        return repairInterleavedArtifact(path);
    } catch  {
        return false;
    }
}
const WORKSPACE_UNIT_FILE = 'workspace.json';
async function readArchivedSessionIds(storagesRoot) {
    const unitPath = external_node_path_join(storagesRoot, WORKSPACE_UNIT_FILE);
    let raw;
    try {
        raw = await readFile(unitPath, 'utf8');
    } catch (error) {
        if ('ENOENT' === error.code) return new Set();
        throw error;
    }
    const parsed = JSON.parse(raw);
    const global = 'object' == typeof parsed && null !== parsed ? parsed.global : void 0;
    const archived = 'object' == typeof global && null !== global ? global.archivedSessionIds : void 0;
    if (!Array.isArray(archived)) throw new Error(`workspace storage unit is malformed: missing global.archivedSessionIds array in ${unitPath}`);
    return new Set(archived.filter((id)=>'string' == typeof id));
}
const PAGER_BUILTIN_COMMANDS = new Set([
    'always-approve',
    'announcements',
    'auto',
    'btw',
    'cd',
    'compact',
    'compact-mode',
    'config-agents',
    'context',
    'copy',
    'dashboard',
    'debug',
    'delete',
    'docs',
    'doctor',
    'edit-prompt',
    'effort',
    'expand',
    'export',
    'feedback',
    'find',
    'fork',
    'gboom',
    'help',
    'history',
    'home',
    'hooks',
    'import-claude',
    'jump',
    'login',
    'logout',
    'loop',
    'mcps',
    'model',
    'multiline',
    'new',
    'personas',
    'plan',
    'privacy',
    'queue',
    'quit',
    'recap',
    'release-notes',
    'remember',
    'rename',
    'resume',
    'rewind',
    'scroll-debug',
    'session-info',
    'settings',
    'share',
    'tasks',
    'theme',
    'timeline',
    'timestamps',
    'toggle-mouse-reporting',
    "transcript",
    'tutorial',
    'usage',
    'view-plan',
    'vim-mode',
    'voice',
    'workflows'
]);
function parseSlashLine(line) {
    const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line);
    if (null === match) return;
    const name = match[1];
    if (void 0 === name) return;
    return {
        name,
        rawInput: line.slice(match[0].length)
    };
}
function isPagerBuiltin(name) {
    return PAGER_BUILTIN_COMMANDS.has(name);
}
function filterPagerConflicts(descriptors) {
    return descriptors.filter((descriptor)=>!isPagerBuiltin(descriptor.name));
}
function toAvailableCommands(descriptors) {
    return descriptors.map((descriptor)=>({
            name: descriptor.name,
            description: descriptor.description,
            input: descriptor.input?.hint !== void 0 && descriptor.input.hint.length > 0 ? {
                type: 'unstructured',
                hint: descriptor.input.hint
            } : null
        }));
}
const ASK_DESCRIPTION = "Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. Send one or more questions, each with a stable id that will be echoed in the answer.";
const askUserQuestionParameters = {
    questions: {
        type: 'array',
        required: true,
        description: 'Questions to ask the user before continuing.',
        items: {
            type: 'object',
            additionalProperties: true,
            properties: {
                id: {
                    type: 'string',
                    required: true,
                    description: 'Stable id for this question; echoed in the answer.'
                },
                question: {
                    type: 'string',
                    required: true,
                    description: 'The specific question to ask the user.'
                },
                header: {
                    type: 'string',
                    description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".'
                },
                options: {
                    type: 'array',
                    description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
                    items: {
                        type: 'object',
                        additionalProperties: true,
                        properties: {
                            label: {
                                type: 'string',
                                required: true,
                                description: 'Short user-facing option label.'
                            },
                            description: {
                                type: 'string',
                                description: 'One sentence explaining the tradeoff or impact.'
                            }
                        }
                    }
                },
                multi_select: {
                    type: 'boolean',
                    description: 'Whether the user may select more than one option. Defaults to false.'
                }
            }
        }
    }
};
const askUserQuestionOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        answers: {
            type: 'array',
            required: true,
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: {
                        type: 'string',
                        required: true
                    },
                    selected: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'string'
                        }
                    },
                    custom: {
                        type: 'string'
                    }
                }
            }
        }
    }
};
function installShadowAsk(agentCtx, questions) {
    return agentCtx.tools.register(defineTool({
        name: 'ask_user_question',
        description: ASK_DESCRIPTION,
        parameters: askUserQuestionParameters,
        output: {
            schema: askUserQuestionOutputSchema,
            render: (_args, value)=>[
                    {
                        type: 'text',
                        text: JSON.stringify(value)
                    }
                ]
        },
        async execute (args, exec) {
            const result = await questions.ask({
                questions: args.questions.map((question)=>({
                        id: question.id,
                        question: question.question,
                        ...void 0 === question.header ? {} : {
                            header: question.header
                        },
                        ...void 0 !== question.options ? {
                            options: question.options
                        } : {},
                        ...void 0 !== question.multi_select ? {
                            multiSelect: question.multi_select
                        } : {}
                    })),
                ...void 0 !== exec.agent ? {
                    agent: exec.agent
                } : {},
                signal: exec.signal
            });
            return {
                answers: result.answers.map((answer)=>({
                        id: answer.id,
                        selected: [
                            ...answer.selected
                        ],
                        ...void 0 !== answer.custom ? {
                            custom: answer.custom
                        } : {}
                    }))
            };
        }
    }));
}
function turnEndToStopReason(reason) {
    switch(reason.kind){
        case 'completed':
            return 'end_turn';
        case 'max-tokens':
            return 'max_tokens';
        case 'aborted':
        case 'interrupted':
            return 'cancelled';
        case 'error':
            return 'end_turn';
        default:
            return 'end_turn';
    }
}
function acpPromptToText(prompt) {
    return prompt.flatMap((block)=>{
        switch(block.type){
            case 'text':
                return [
                    block.text
                ];
            case 'resource_link':
                return [
                    `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`
                ];
            default:
                return [];
        }
    }).join('');
}
function promptHasUnsupportedContent(prompt) {
    return prompt.some((block)=>'text' !== block.type && 'resource_link' !== block.type);
}
const session_store_zstdDecompressAsync = promisify(zstdDecompress);
const LOG_FILE = 'session.jsonl.zstd';
async function sessionLogState(sessionsRoot, sessionId) {
    let projects;
    try {
        projects = await promises_readdir(sessionsRoot);
    } catch  {
        return {
            kind: 'absent'
        };
    }
    for (const project of projects){
        const log = external_node_path_join(sessionsRoot, project, sessionId, LOG_FILE);
        try {
            const info = await promises_stat(log);
            if (!info.isFile()) continue;
        } catch  {
            continue;
        }
        const first = await firstLogLine(log);
        return void 0 === first ? {
            kind: 'empty',
            path: log
        } : {
            kind: 'valid',
            path: log
        };
    }
    return {
        kind: 'absent'
    };
}
async function removeSessionLog(sessionsRoot, sessionId) {
    let projects;
    try {
        projects = await promises_readdir(sessionsRoot);
    } catch  {
        return false;
    }
    for (const project of projects){
        const dir = external_node_path_join(sessionsRoot, project, sessionId);
        try {
            await rm(dir, {
                recursive: true,
                force: true
            });
            return true;
        } catch  {
            break;
        }
    }
    return false;
}
async function firstLogLine(log) {
    try {
        const handle = await promises_open(log, 'r');
        try {
            const buf = Buffer.alloc(1048576);
            const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
            const frames = first_prompt_scanZstdFrames(buf.subarray(0, bytesRead), 4);
            const first = frames[0];
            if (void 0 === first) return;
            const text = (await session_store_zstdDecompressAsync(buf.subarray(first.start, first.end))).toString('utf8');
            return text.split('\n').find((line)=>line.trim().length > 0);
        } finally{
            await handle.close();
        }
    } catch  {
        return;
    }
}
async function waitForSessionLog(sessionsRoot, sessionId, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    for(;;){
        const state = await sessionLogState(sessionsRoot, sessionId);
        if ('absent' !== state.kind) return state;
        if (Date.now() >= deadline) throw new Error(`session log for ${sessionId} did not appear within ${timeoutMs}ms`);
        await new Promise((resolve)=>setTimeout(resolve, 20));
    }
}
function toGrokToolName(name) {
    switch(name){
        case 'web_fetch':
            return 'webfetch';
        case 'web_search':
            return 'websearch';
        case 'todo_write':
            return 'todowrite';
        case 'str_replace_editor':
            return 'edit';
        case 'subagent':
            return 'task';
        case 'ask_user_question':
            return 'question';
        default:
            return name;
    }
}
function toolKindOf(name) {
    switch(name){
        case 'bash':
            return 'execute';
        case 'str_replace_editor':
        case 'write':
            return 'edit';
        case 'read':
        case 'glob':
            return 'read';
        case 'grep':
            return 'search';
        case 'web_fetch':
            return 'fetch';
        case 'web_search':
            return 'search';
        default:
            return 'other';
    }
}
function toCamelCase(key) {
    return key.replace(/_([a-z0-9])/gu, (_match, char)=>char.toUpperCase());
}
function shapeToolInput(input) {
    const shaped = {};
    for (const [key, value] of Object.entries(input))shaped[toCamelCase(key)] = value;
    return shaped;
}
function toolTitle(displayName, input) {
    if ('bash' === displayName) {
        const command = input.command;
        return 'string' == typeof command ? command : displayName;
    }
    if ('edit' === displayName) {
        const filePath = input.filePath ?? input.path;
        return 'string' == typeof filePath ? String(filePath) : displayName;
    }
    if ('read' === displayName || 'glob' === displayName) {
        const filePath = input.filePath ?? input.path;
        return 'string' == typeof filePath ? String(filePath) : displayName;
    }
    if ('websearch' === displayName) {
        const query = input.query;
        return 'string' == typeof query ? `Web search: ${query}` : displayName;
    }
    if ('webfetch' === displayName) {
        const url = input.url;
        return 'string' == typeof url ? `Web fetch: ${url}` : displayName;
    }
    if ('todowrite' === displayName) {
        const todos = todoList(input.todos);
        const open = todos.filter((todo)=>'completed' !== todo.status).length;
        return `${open} todos`;
    }
    if ('question' === displayName) {
        const count = Array.isArray(input.questions) ? input.questions.length : 0;
        return `Asked ${count} question${1 === count ? '' : 's'}`;
    }
    return displayName;
}
function extractToolOutput(content) {
    if (!Array.isArray(content)) return '';
    const texts = [];
    for (const item of content){
        if ('object' != typeof item || null === item) continue;
        const block = item;
        if (Array.isArray(block.content)) {
            for (const inner of block.content)if ('object' == typeof inner && null !== inner) {
                const text = inner.text;
                if ('string' == typeof text) texts.push(text);
            }
        } else if ('string' == typeof block.text) texts.push(block.text);
    }
    return texts.join('\n');
}
function todoList(value) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item)=>{
        if ('object' != typeof item || null === item) return [];
        const record = item;
        const content = record.content;
        const status = record.status;
        if ('string' != typeof content || 'string' != typeof status) return [];
        return [
            {
                content,
                status
            }
        ];
    });
}
function metaDiffs(meta) {
    if ('object' != typeof meta || null === meta || Array.isArray(meta)) return [];
    const diffs = meta.diffs;
    if (!Array.isArray(diffs)) return [];
    return diffs.flatMap((item)=>{
        if ('object' != typeof item || null === item) return [];
        const record = item;
        const { path, oldText, newText } = record;
        if ('string' != typeof path || 'string' != typeof newText) return [];
        if (null !== oldText && 'string' != typeof oldText) return [];
        return [
            {
                path,
                oldText,
                newText
            }
        ];
    });
}
function toolOutputFor(displayName, input, output, meta) {
    if ('bash' === displayName) {
        const command = 'string' == typeof input.command ? input.command : '';
        const failed = 0 === output.trim().length;
        return {
            type: 'Bash',
            output: Array.from(Buffer.from(output, 'utf8')),
            output_for_prompt: '',
            exit_code: failed ? 1 : 0,
            command,
            truncated: false,
            timed_out: false,
            current_dir: ''
        };
    }
    if ('read' === displayName) {
        const path = 'string' == typeof input.filePath ? input.filePath : 'string' == typeof input.path ? input.path : '';
        const lines = output.split('\n');
        return {
            type: 'ReadFile',
            FileContent: {
                content: output,
                absolute_path: path,
                offset: null,
                limit: null,
                total_lines: lines.length,
                raw_output: output
            }
        };
    }
    if ('edit' === displayName) {
        const diffs = metaDiffs(meta);
        const details = diffs.map((diff)=>({
                old_string: diff.oldText ?? '',
                old_line: 1,
                new_string: diff.newText,
                new_line: 1,
                context_before: '',
                context_after: ''
            }));
        const path = 'string' == typeof input.filePath ? input.filePath : 'string' == typeof input.path ? input.path : '';
        return {
            type: 'SearchReplace',
            EditsApplied: {
                old_string: details[0]?.old_string ?? '',
                new_string: details[0]?.new_string ?? '',
                tool_output_for_prompt: '',
                absolute_path: path,
                edits: {
                    details
                },
                patch: void 0
            }
        };
    }
    if ('websearch' === displayName) {
        const query = 'string' == typeof input.query ? input.query : '';
        return {
            type: 'WebSearch',
            query,
            content: output,
            citations: []
        };
    }
    if ('todowrite' === displayName) return {
        type: 'Todo',
        todos: todoList(input.todos)
    };
    return {
        type: 'Text',
        text: output
    };
}
function safeJsonParse(raw) {
    try {
        const parsed = JSON.parse(raw);
        return 'object' == typeof parsed && null !== parsed ? parsed : {
            value: parsed
        };
    } catch  {
        return {};
    }
}
function events_notification(sessionId, update, event, replay, usage) {
    return {
        sessionId,
        update,
        _meta: {
            eventId: `${String(sessionId)}-${event.seq}`,
            agentTimestampMs: event.time,
            isReplay: replay,
            ...void 0 === usage || 0 === usage.pressureTokens ? {} : {
                totalTokens: usage.pressureTokens
            },
            ...void 0 === usage || 0 === usage.apiCalls ? {} : {
                dshUsage: usage
            }
        }
    };
}
function buildUsageUpdateNotification(sessionId, usage, event, replay) {
    return events_notification(sessionId, {
        sessionUpdate: 'usage_update',
        used: usage.pressureTokens,
        size: 0
    }, event, replay, usage);
}
function translateEvent(sessionId, event, calls, replay = false, usage) {
    switch(event.type){
        case 'assistant/chunk':
            {
                const chunk = event.data.chunk;
                if ('text-delta' === chunk.type && chunk.text.length > 0) return [
                    events_notification(sessionId, {
                        sessionUpdate: 'agent_message_chunk',
                        content: {
                            type: 'text',
                            text: chunk.text
                        }
                    }, event, replay, usage)
                ];
                if ('reasoning-delta' === chunk.type && chunk.text.length > 0) return [
                    events_notification(sessionId, {
                        sessionUpdate: 'agent_thought_chunk',
                        content: {
                            type: 'text',
                            text: chunk.text
                        }
                    }, event, replay, usage)
                ];
                return [];
            }
        case 'user/message':
            {
                if (!replay) return [];
                const text = event.data.content.filter((block)=>'text' === block.type).map((block)=>block.text).join('');
                if (0 === text.length) return [];
                return [
                    events_notification(sessionId, {
                        sessionUpdate: 'user_message_chunk',
                        content: {
                            type: 'text',
                            text
                        }
                    }, event, true, usage)
                ];
            }
        case 'assistant/message':
            if (!replay) return [];
            return event.data.message.content.filter((block)=>'text' === block.type).flatMap((block)=>{
                const text = block.text;
                if (0 === text.length) return [];
                return [
                    events_notification(sessionId, {
                        sessionUpdate: 'agent_message_chunk',
                        content: {
                            type: 'text',
                            text
                        }
                    }, event, true, usage)
                ];
            });
        case 'tool/call':
            {
                const displayName = toGrokToolName(event.data.name);
                const input = shapeToolInput(safeJsonParse(event.data.arguments));
                calls.set(String(event.data.callId), {
                    displayName,
                    input
                });
                return [
                    events_notification(sessionId, {
                        sessionUpdate: 'tool_call',
                        toolCallId: String(event.data.callId),
                        title: toolTitle(displayName, input),
                        kind: toolKindOf(event.data.name),
                        rawInput: input
                    }, event, replay, usage)
                ];
            }
        case 'tool/result':
            {
                const callId = String(event.data.message.source.callId);
                const record = calls.get(callId);
                const output = extractToolOutput(event.data.message.content);
                const rawOutput = void 0 === record ? {
                    type: 'Text',
                    text: output
                } : toolOutputFor(record.displayName, record.input, output, event.data.meta);
                const update = {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: callId,
                    rawOutput,
                    ...void 0 !== event.data.error ? {
                        status: 'failed'
                    } : {}
                };
                return [
                    events_notification(sessionId, update, event, replay, usage)
                ];
            }
        case 'todo/write':
            return [
                events_notification(sessionId, {
                    sessionUpdate: 'plan',
                    entries: event.data.todos.map((todo)=>({
                            content: todo.content,
                            status: todo.status,
                            priority: 'medium'
                        }))
                }, event, replay, usage)
            ];
        default:
            return [];
    }
}
function createUsageState() {
    return {
        consumedSeq: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        apiCalls: 0,
        toolDurationMs: 0,
        pressureTokens: 0,
        lastUsageKey: void 0,
        toolStarts: new Map(),
        ttftSumMs: 0,
        completedTurns: 0,
        totalDecodeMs: 0,
        turnStartMs: void 0,
        turnFirstStepStartMs: void 0,
        turnStartOutputTokens: 0,
        firstChunkMs: void 0,
        decodeStep: void 0,
        decodeStepFirstMs: void 0,
        decodeStepLastDeltaMs: void 0,
        turnDecodeMs: 0
    };
}
function isTokenDelta(chunk) {
    switch(chunk.type){
        case 'text-delta':
        case 'reasoning-delta':
            return '' !== chunk.text;
        case 'tool-call-delta':
            return '' !== chunk.argumentsDelta || void 0 !== chunk.name;
        default:
            return false;
    }
}
function foldUsage(state, event) {
    if (event.seq <= state.consumedSeq) return;
    state.consumedSeq = event.seq;
    switch(event.type){
        case 'turn/start':
            state.turnStartMs = event.time;
            state.turnFirstStepStartMs = void 0;
            state.firstChunkMs = void 0;
            state.turnStartOutputTokens = state.outputTokens;
            state.turnDecodeMs = 0;
            state.decodeStep = void 0;
            state.decodeStepFirstMs = void 0;
            return;
        case 'turn/end':
            if (void 0 !== state.turnStartMs) {
                const stepStart = state.turnFirstStepStartMs;
                if (void 0 !== state.firstChunkMs && void 0 !== stepStart) {
                    state.ttftSumMs += state.firstChunkMs - stepStart;
                    state.completedTurns += 1;
                }
                settleDecodeStep(state, event.time);
                state.totalDecodeMs += state.turnDecodeMs;
            }
            state.turnStartMs = void 0;
            state.turnFirstStepStartMs = void 0;
            state.firstChunkMs = void 0;
            state.turnDecodeMs = 0;
            state.decodeStep = void 0;
            state.decodeStepFirstMs = void 0;
            return;
        case 'step/start':
            state.apiCalls += 1;
            if (void 0 === state.turnFirstStepStartMs) state.turnFirstStepStartMs = event.time;
            return;
        case 'compact/start':
            state.apiCalls += 1;
            return;
        case 'assistant/chunk':
            {
                const chunk = event.data.chunk;
                if (isTokenDelta(chunk)) {
                    const step = event.data.step;
                    if (state.decodeStep !== step) {
                        settleDecodeStep(state, state.decodeStepLastDeltaMs);
                        state.decodeStep = step;
                        state.decodeStepFirstMs = event.time;
                        state.decodeStepLastDeltaMs = event.time;
                        if (void 0 === state.firstChunkMs) state.firstChunkMs = event.time;
                    } else state.decodeStepLastDeltaMs = event.time;
                    return;
                }
                if ('usage' === chunk.type) {
                    state.lastUsageKey = {
                        turn: event.data.turn,
                        step: event.data.step
                    };
                    accumulate(state, chunk.usage);
                }
                return;
            }
        case 'assistant/message':
            {
                settleDecodeStep(state, event.time);
                const usage = event.data.usage;
                if (void 0 === usage) return;
                const key = {
                    turn: event.data.turn,
                    step: event.data.step
                };
                if (state.lastUsageKey?.turn === key.turn && state.lastUsageKey.step === key.step) return;
                state.lastUsageKey = key;
                accumulate(state, usage);
                return;
            }
        case 'tool/call':
            state.toolStarts.set(String(event.data.callId), event.time);
            return;
        case 'tool/result':
            {
                const start = state.toolStarts.get(String(event.data.message.source.callId));
                if (void 0 !== start) state.toolDurationMs += Math.max(0, event.time - start);
                return;
            }
        default:
            return;
    }
}
function foldUsageWithView(state, event) {
    const before = toUsageView(state);
    foldUsage(state, event);
    const after = toUsageView(state);
    return usageViewsEqual(before, after) ? null : after;
}
function settleDecodeStep(state, completedTime) {
    const first = state.decodeStepFirstMs;
    if (void 0 !== first && void 0 !== completedTime && completedTime > first) state.turnDecodeMs += completedTime - first;
    state.decodeStep = void 0;
    state.decodeStepFirstMs = void 0;
    state.decodeStepLastDeltaMs = void 0;
}
function usageViewsEqual(left, right) {
    return left.inputTokens === right.inputTokens && left.outputTokens === right.outputTokens && left.cacheReadTokens === right.cacheReadTokens && left.cacheWriteTokens === right.cacheWriteTokens && left.apiCalls === right.apiCalls && left.toolDurationMs === right.toolDurationMs && left.pressureTokens === right.pressureTokens && left.ttftMs === right.ttftMs && left.tps === right.tps;
}
function accumulate(state, usage) {
    state.inputTokens += usage.inputTokens;
    state.outputTokens += usage.outputTokens;
    state.cacheReadTokens += usage.cacheReadTokens ?? 0;
    state.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    state.pressureTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}
function toUsageView(state) {
    return {
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        cacheReadTokens: state.cacheReadTokens,
        cacheWriteTokens: state.cacheWriteTokens,
        apiCalls: state.apiCalls,
        toolDurationMs: state.toolDurationMs,
        pressureTokens: state.pressureTokens,
        ttftMs: state.completedTurns > 0 ? state.ttftSumMs / state.completedTurns : void 0,
        tps: state.totalDecodeMs > 0 ? 1000 * state.outputTokens / state.totalDecodeMs : void 0
    };
}
promisify(zstdDecompress);
const workspace_attach_WORKSPACE_UNIT_FILE = 'workspace.json';
const WORKSPACE_UNIT_VERSION = 2;
function freshUnitDocument() {
    return {
        unit: {
            name: 'workspace',
            version: WORKSPACE_UNIT_VERSION
        },
        global: {
            initialized: true,
            workspaceIds: [],
            archivedSessionIds: []
        },
        tables: {
            workspaces: {}
        }
    };
}
async function readWorkspaceUnit(storagesRoot) {
    const unitPath = external_node_path_join(storagesRoot, workspace_attach_WORKSPACE_UNIT_FILE);
    let raw;
    try {
        raw = await readFile(unitPath, 'utf8');
    } catch (error) {
        if ('ENOENT' === error.code) return;
        throw error;
    }
    const parsed = JSON.parse(raw);
    if ('object' != typeof parsed || null === parsed) throw new Error(`workspace storage unit is malformed in ${unitPath}: not a JSON object`);
    const document = parsed;
    const unitHeader = 'object' == typeof document.unit && null !== document.unit ? document.unit : void 0;
    if (void 0 === unitHeader || 'workspace' !== unitHeader.name || 'number' != typeof unitHeader.version) throw new Error(`workspace storage unit is malformed in ${unitPath}: missing or foreign unit header`);
    if (unitHeader.version !== WORKSPACE_UNIT_VERSION) throw new Error(`workspace storage unit version ${unitHeader.version} != expected ${WORKSPACE_UNIT_VERSION} in ${unitPath}`);
    const tables = 'object' == typeof document.tables && null !== document.tables ? document.tables : void 0;
    const workspaces = tables?.workspaces;
    if ('object' != typeof workspaces || null === workspaces || Array.isArray(workspaces)) throw new Error(`workspace storage unit is malformed in ${unitPath}: missing workspaces table`);
    return {
        document,
        workspaces: workspaces
    };
}
async function matchingWorkspacePath(unit, cwd) {
    let canonical;
    try {
        canonical = await realpath(cwd);
    } catch  {
        return;
    }
    const record = Object.values(unit.workspaces).find((candidate)=>candidate.path === canonical);
    return record?.path;
}
async function canonicalDirectory(cwd) {
    try {
        const canonical = await realpath(cwd);
        return (await promises_stat(canonical)).isDirectory() ? canonical : void 0;
    } catch  {
        return;
    }
}
function accountedAnywhere(unit, sessionId) {
    return Object.values(unit.workspaces).some((record)=>record.sessionIds.includes(sessionId));
}
async function attachSessionToWorkspace(storagesRoot, sessionId, cwd) {
    const unit = await readWorkspaceUnit(storagesRoot);
    if (void 0 !== unit) {
        const canonical = await matchingWorkspacePath(unit, cwd);
        if (void 0 !== canonical) {
            if (accountedAnywhere(unit, sessionId)) return 'already-attached';
            const record = Object.values(unit.workspaces).find((candidate)=>candidate.path === canonical);
            if (!Array.isArray(record.sessionIds)) throw new Error('workspace storage unit is malformed: workspace record has a non-array sessionIds');
            record.sessionIds.unshift(sessionId);
            record.updatedAt = new Date().toISOString();
            await writeUnitAtomic(external_node_path_join(storagesRoot, workspace_attach_WORKSPACE_UNIT_FILE), unit.document);
            return 'attached';
        }
    }
    const canonical = await canonicalDirectory(cwd);
    if (void 0 === canonical) return 'cwd-unresolved';
    if (void 0 !== unit && accountedAnywhere(unit, sessionId)) return 'already-attached';
    const now = new Date().toISOString();
    const id = external_node_crypto_randomUUID();
    const record = {
        path: canonical,
        title: external_node_path_basename(canonical),
        sessionIds: [
            sessionId
        ],
        createdAt: now,
        updatedAt: now
    };
    const document = unit?.document ?? freshUnitDocument();
    let global = document.global;
    if ('object' != typeof global || null === global) {
        global = {
            initialized: true,
            workspaceIds: [],
            archivedSessionIds: []
        };
        document.global = global;
    }
    const workspaces = document.tables.workspaces;
    const workspaceIds = global.workspaceIds;
    workspaces[id] = record;
    workspaceIds.unshift(id);
    await writeUnitAtomic(external_node_path_join(storagesRoot, workspace_attach_WORKSPACE_UNIT_FILE), document);
    return 'registered';
}
async function writeUnitAtomic(path, document) {
    await mkdir(dirname(path), {
        recursive: true
    });
    const tmp = external_node_path_join(dirname(path), `.${external_node_crypto_randomUUID()}.tmp`);
    try {
        const handle = await promises_open(tmp, 'wx', 384);
        try {
            await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
            await handle.sync();
        } finally{
            await handle.close();
        }
        await rename(tmp, path);
        await fsyncDirectory(dirname(path));
    } catch (error) {
        await rm(tmp, {
            force: true
        });
        throw error;
    }
}
async function fsyncDirectory(path) {
    if ('win32' === process.platform) return;
    const handle = await promises_open(path, 'r');
    try {
        await handle.sync();
    } finally{
        await handle.close();
    }
}
async function attachSessionViaWebHost(config, sessionId, cwd) {
    const rpc = async (method, payload)=>{
        const response = await fetch(`${config.origin}/api/${method}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                type: 'client-request',
                rpcId: `grok-${external_node_crypto_randomUUID()}`,
                method,
                payload
            }),
            signal: AbortSignal.timeout(config.timeoutMs ?? 3000)
        });
        if (!response.ok) throw new Error(`web host ${method} returned HTTP ${response.status}`);
        const body = await response.json();
        const result = body.result;
        if (result?.ok !== true || void 0 === result.value) throw new Error(`web host ${method} failed: ${result?.error?.message ?? 'unknown error'}`);
        return result.value;
    };
    const created = await rpc('workspace.create', {
        path: cwd
    });
    await rpc('session.create', {
        sessionId,
        workspaceId: created.workspace.workspaceId
    });
    return true;
}
function invalidParams(detail) {
    return RequestError.invalidParams(void 0, detail);
}
function usageStatusFile() {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
    return external_node_path_join(home, '.dsh', 'grok-usage.json');
}
function internalError(detail) {
    return RequestError.internalError(void 0, detail);
}
function createAcpAgent(ctx, config, channel, logger, questions, lastModel) {
    const agents = ctx.agents;
    const sessions = new Map();
    let closed = false;
    let conn;
    const rememberedModel = ()=>{
        const raw = lastModel?.current;
        if (void 0 === raw) return;
        const at = raw.indexOf(MODEL_ROUTE_SEPARATOR);
        if (at <= 0) return raw;
        const provider = raw.slice(0, at);
        if (ctx.llm.listProviders().some((p)=>p.id === provider)) return raw;
        return raw.slice(at + 1);
    };
    const composeFromPreset = async ()=>{
        const presets = ctx.get('agentPresets');
        if (void 0 === presets) return {};
        const preset = await presets.resolve();
        return {
            agentPreset: preset.id,
            setup: async (agentCtx)=>{
                await presets.mount(agentCtx, preset.id);
            }
        };
    };
    const ownedRecord = (agent)=>{
        const record = sessions.get(agent.session.id);
        return record?.agent === agent ? record : void 0;
    };
    const assertOpen = ()=>{
        if (closed) throw internalError('the grok connection has been disposed');
    };
    const requireSession = (sessionId)=>{
        const record = sessions.get(sessionId);
        if (void 0 === record) throw invalidParams(`unknown session: ${sessionId}`);
        return record;
    };
    const adoptLiveAgent = (sessionId)=>{
        const live = ctx.agents.get(sessionId);
        if (void 0 === live) return;
        logger.info(`grok-server: session ${sessionId} already live in this host — adopting the shared agent`);
        return {
            agent: live,
            dispose: ()=>Promise.resolve(),
            adopted: true,
            inflight: void 0
        };
    };
    const installShadow = (record)=>{
        if (void 0 === questions) return;
        const tools = record.agent.ctx.get('tools');
        if (void 0 === tools) return void logger.info('grok-server: no tools service in the agent scope — skipping the scoped shadow ask tool');
        record.disposeShadow?.();
        record.disposeShadow = installShadowAsk(record.agent.ctx, questions);
    };
    const commands = ctx.get('commands');
    const dshCommandsOf = (record)=>{
        if (void 0 === commands) return [];
        return filterPagerConflicts(commands.list(record.agent));
    };
    const pushAvailableCommands = (record)=>{
        if (void 0 === conn) return;
        const availableCommands = toAvailableCommands(dshCommandsOf(record));
        conn.sessionUpdate({
            sessionId: record.agent.session.id,
            update: {
                sessionUpdate: 'available_commands_update',
                availableCommands
            }
        }).catch((error)=>{
            logger.warn(`grok-server: available_commands_update failed: ${String(error)}`);
        });
    };
    const tryExecuteDshCommand = async (record, text)=>{
        if (void 0 === commands) return false;
        const line = text.trim();
        const parsed = parseSlashLine(line);
        if (void 0 === parsed) return false;
        if (isPagerBuiltin(parsed.name)) return false;
        if (!dshCommandsOf(record).some((cmd)=>cmd.name === parsed.name)) return false;
        const controller = new AbortController();
        record.commandAbort?.abort();
        record.commandAbort = controller;
        logger.info(`grok-server: executing DSH command /${parsed.name} for session ${record.agent.session.id}`);
        let resultText;
        try {
            const execution = await commands.execute(record.agent, line, controller.signal);
            resultText = void 0 === execution ? `Unknown command /${parsed.name}.` : execution.result.text ?? '';
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            resultText = `Command /${parsed.name} failed: ${detail}`;
        }
        notify({
            sessionId: record.agent.session.id,
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                    type: 'text',
                    text: resultText
                }
            }
        });
        return true;
    };
    const resumeWithRepair = async (sessionId)=>{
        const adopted = adoptLiveAgent(sessionId);
        if (void 0 !== adopted) return {
            agent: adopted.agent,
            dispose: adopted.dispose,
            adopted: true
        };
        try {
            const composed = await composeFromPreset();
            return await agents.resume({
                resumeSessionId: sessionId,
                agentOptions: agentOptions(config),
                ...void 0 !== composed.setup ? {
                    setup: composed.setup
                } : {}
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (void 0 === config.persistenceRoot || !detail.includes('corrupt session log')) throw error;
            const { repairInterleavedLog } = await Promise.resolve(repair_namespaceObject);
            if (!await repairInterleavedLog(config.persistenceRoot, sessionId)) throw error;
            const composed = await composeFromPreset();
            return await agents.resume({
                resumeSessionId: sessionId,
                agentOptions: agentOptions(config),
                ...void 0 !== composed.setup ? {
                    setup: composed.setup
                } : {}
            });
        }
    };
    const logIdentityOf = async (session)=>{
        if (void 0 === config.persistenceRoot) return;
        const { stat } = await import("node:fs/promises");
        try {
            const st = await stat(sessionLogPath(config.persistenceRoot, session.header.cwd, String(session.header.id)));
            return {
                size: st.size,
                mtimeMs: st.mtimeMs
            };
        } catch  {
            return;
        }
    };
    const notify = (notification)=>{
        if (void 0 === conn) return;
        conn.sessionUpdate(notification).catch((error)=>{
            logger.warn(`grok-server: session/update failed: ${String(error)}`);
        });
        const usage = notification._meta?.dshUsage;
        if (void 0 === usage) return;
        writeFile(usageStatusFile(), `${JSON.stringify({
            sessionId: String(notification.sessionId),
            updatedAt: Date.now(),
            usage
        })}\n`).catch(()=>{});
    };
    const settlePrompt = (record, reason)=>{
        const inflight = record.inflight;
        if (void 0 === inflight) return;
        record.inflight = void 0;
        inflight.resolve(reason);
    };
    const rejectFromError = (inflight, reason)=>{
        inflight.reject(internalError(`turn failed: ${reason.error.message}`));
    };
    const calls = new Map();
    const usageBySession = new Map();
    const workspaceAttached = new Set();
    const attachWorkspace = async (sessionId, cwd, storageRoot)=>{
        const fallback = ()=>attachSessionToWorkspace(storageRoot, String(sessionId), cwd).then((outcome)=>{
                if ('cwd-unresolved' === outcome) logger.info(`grok-server: session ${sessionId} left ungrouped in the web workspace registry (${outcome})`);
            }).catch((error)=>{
                logger.warn(`grok-server: could not attach session ${sessionId} to a web workspace: ${String(error)}`);
            });
        if (void 0 !== config.persistenceRoot) try {
            await waitForSessionLog(config.persistenceRoot, String(sessionId), 2000);
        } catch  {
            logger.warn(`grok-server: session ${sessionId} log not observed after flush — attaching anyway`);
        }
        const workspace = ctx.get('workspace');
        if (void 0 !== workspace) try {
            const existing = await workspace.resolveByPath(cwd);
            const ws = existing ?? await workspace.create(cwd);
            await ws.attachSession(String(sessionId));
            return;
        } catch (error) {
            logger.warn(`grok-server: in-process workspace attach failed (${String(error)}), falling back`);
        }
        if (void 0 !== config.webPort) try {
            await attachSessionViaWebHost({
                origin: `http://127.0.0.1:${config.webPort}`
            }, String(sessionId), cwd);
            return;
        } catch (error) {
            logger.info(`grok-server: web-host attach unavailable (${String(error)}), writing the shared unit directly`);
        }
        await fallback();
    };
    const disposeEvents = ctx.on('session/event', (session, event)=>{
        const record = sessions.get(session.header.id);
        if (void 0 === record || record.agent.session !== session) return;
        try {
            let usage = usageBySession.get(session.header.id);
            if (void 0 === usage) {
                usage = createUsageState();
                usageBySession.set(session.header.id, usage);
            }
            const view = foldUsageWithView(usage, event);
            if (null !== view) notify(buildUsageUpdateNotification(session.header.id, view, event, false));
            for (const update of translateEvent(session.header.id, event, calls, false, view ?? void 0))notify(update);
        } finally{
            const inflight = record.inflight;
            if (void 0 !== inflight && 'turn/end' === event.type && inflight.turn === event.data.turn) if ('error' === event.data.reason.kind) {
                record.inflight = void 0;
                rejectFromError(inflight, event.data.reason);
            } else {
                record.inflight = void 0;
                inflight.resolve(turnEndToStopReason(event.data.reason));
            }
            if ('turn/end' === event.type && void 0 !== config.storageRoot && void 0 !== session.header.cwd && !workspaceAttached.has(session.header.id)) {
                workspaceAttached.add(session.header.id);
                attachWorkspace(session.header.id, session.header.cwd, config.storageRoot);
            }
        }
    });
    const disposeClaimed = ctx.on('agent/inbox/claimed', ({ agent, message, turn })=>{
        const record = ownedRecord(agent);
        const inflight = record?.inflight;
        if (void 0 !== inflight && inflight.messageId === message.id) inflight.turn = turn;
    });
    const disposeFlush = ctx.on('session/flush', (session)=>{
        const record = sessions.get(session.header.id);
        if (void 0 === record || record.agent.session !== session) return;
        if (true === record.adopted) return;
        logIdentityOf(session).then((identity)=>{
            const current = sessions.get(session.header.id);
            if (current === record && void 0 !== identity) current.logIdentity = identity;
        });
    });
    const disposeApproval = ctx.on('approval/request', (request, next)=>{
        const record = ownedRecord(request.agent);
        if (void 0 === record || void 0 === request.callId || void 0 === conn) return next();
        return conn.requestPermission({
            sessionId: record.agent.session.id,
            toolCall: {
                toolCallId: request.callId
            },
            options: [
                {
                    optionId: 'allow-once',
                    name: 'Allow once',
                    kind: 'allow_once'
                },
                {
                    optionId: 'reject-once',
                    name: 'Reject',
                    kind: 'reject_once'
                }
            ]
        }).then(({ outcome })=>{
            if ('cancelled' === outcome.outcome) return 'cancelled';
            return 'allow-once' === outcome.optionId ? 'allowed-once' : 'rejected';
        });
    }, {
        prepend: true
    });
    const disposeCommandsChange = ctx.on('commands/change', ()=>{
        if (void 0 === conn) return;
        for (const record of sessions.values())pushAvailableCommands(record);
    });
    const agent = {
        async initialize (_params) {
            return {
                protocolVersion: PROTOCOL_VERSION,
                agentInfo: {
                    name: 'dsh-grok-tui',
                    version: '0.1.0'
                },
                agentCapabilities: {
                    promptCapabilities: {
                        image: false,
                        audio: false,
                        embeddedContext: false
                    }
                },
                authMethods: [
                    {
                        id: 'xai.api_key',
                        name: 'xai.api_key'
                    }
                ],
                _meta: {
                    defaultAuthMethodId: 'xai.api_key',
                    modelState: await modelState(ctx, config, rememberedModel())
                }
            };
        },
        authenticate (_params) {
            return Promise.resolve();
        },
        async newSession (params) {
            assertOpen();
            validateSessionParams(params);
            const sessionId = SessionId('string' == typeof params._meta?.sessionId ? params._meta.sessionId : external_node_crypto_randomUUID());
            const adopted = adoptLiveAgent(sessionId);
            if (void 0 !== adopted) {
                sessions.set(sessionId, adopted);
                installShadow(adopted);
                if (void 0 !== questions) questions.register(String(sessionId), connectionRef());
                connectionRef().extNotification('_x.ai/mcp_initialized', {
                    sessionId: String(sessionId)
                });
                pushAvailableCommands(adopted);
                return {
                    sessionId
                };
            }
            const persisted = void 0 === config.persistenceRoot ? void 0 : await sessionLogState(config.persistenceRoot, String(sessionId));
            if (persisted?.kind === 'empty') {
                logger.warn(`grok-server: removing empty session log for ${sessionId} (${persisted.path})`);
                await removeSessionLog(config.persistenceRoot, String(sessionId));
            }
            let handle;
            if (persisted?.kind === 'valid') {
                logger.warn(`grok-server: session ${sessionId} already has a log on disk — resuming instead of creating`);
                handle = await resumeWithRepair(sessionId);
            } else try {
                const composed = await composeFromPreset();
                handle = await agents.create({
                    sessionId,
                    meta: {
                        cwd: params.cwd,
                        agentPreset: composed.agentPreset
                    },
                    agentOptions: agentOptions(config, rememberedModel()),
                    ...void 0 !== composed.setup ? {
                        setup: composed.setup
                    } : {}
                });
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                if (!detail.includes('refusing to materialize') && !detail.includes('already exists')) throw error;
                logger.warn(`grok-server: create raced an existing log for ${sessionId} — resuming`);
                handle = await resumeWithRepair(sessionId);
            }
            if (closed) {
                await handle.dispose();
                throw internalError('connection closed during session/new');
            }
            const logIdentity = await logIdentityOf(handle.agent.session);
            const record = {
                agent: handle.agent,
                dispose: ()=>handle.dispose(),
                inflight: void 0,
                ...'adopted' in handle && true === handle.adopted ? {
                    adopted: true
                } : {},
                ...void 0 === logIdentity ? {} : {
                    logIdentity
                }
            };
            sessions.set(sessionId, record);
            installShadow(record);
            if (void 0 !== questions) questions.register(String(sessionId), connectionRef());
            connectionRef().extNotification('_x.ai/mcp_initialized', {
                sessionId: String(sessionId)
            });
            pushAvailableCommands(record);
            return {
                sessionId
            };
        },
        async prompt (params) {
            assertOpen();
            const sessionId = SessionId(params.sessionId);
            const record = requireSession(sessionId);
            if (void 0 !== record.inflight) throw invalidParams('a prompt is already in flight for this session');
            if (promptHasUnsupportedContent(params.prompt)) throw invalidParams('only text and resource_link prompt content is supported');
            const text = acpPromptToText(params.prompt);
            if (0 === text.trim().length) throw invalidParams('empty prompt');
            await alignWithSharedLog(record, sessionId);
            if (await tryExecuteDshCommand(record, text)) return {
                stopReason: 'end_turn'
            };
            if (ctx.agents.get(record.agent.id) !== record.agent) throw internalError('prompt was not queued: the agent was disposed outside the bridge');
            const stopReason = await new Promise((resolve, reject)=>{
                const message = createUserMessage({
                    content: [
                        {
                            type: 'text',
                            text
                        }
                    ],
                    source: {
                        kind: 'user'
                    }
                });
                const inflight = {
                    resolve,
                    reject,
                    messageId: message.id,
                    turn: void 0
                };
                record.inflight = inflight;
                try {
                    record.agent.followup(message);
                } catch (error) {
                    record.inflight = void 0;
                    const detail = error instanceof Error ? error.message : String(error);
                    throw internalError(`prompt was not queued: ${detail}`);
                }
                record.agent.whenIdle().then(()=>{
                    if (record.inflight !== inflight || void 0 !== inflight.turn) return;
                    record.inflight = void 0;
                    inflight.resolve('cancelled');
                });
            });
            return {
                stopReason
            };
        },
        cancel (params) {
            const record = sessions.get(SessionId(params.sessionId));
            if (void 0 === record) return Promise.resolve();
            record.commandAbort?.abort();
            record.agent.cancel({
                kind: 'user'
            });
            settlePrompt(record, 'cancelled');
            return Promise.resolve();
        },
        async loadSession (params) {
            assertOpen();
            if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`);
            const sessionId = SessionId(params.sessionId);
            let record = sessions.get(sessionId);
            if (void 0 === record) {
                const handle = await resumeWithRepair(sessionId);
                if (closed) {
                    await handle.dispose();
                    throw internalError('connection closed during session/load');
                }
                record = {
                    agent: handle.agent,
                    dispose: ()=>handle.dispose(),
                    inflight: void 0,
                    ...true === handle.adopted ? {
                        adopted: true
                    } : {}
                };
                if (true !== handle.adopted) {
                    const logIdentity = await logIdentityOf(handle.agent.session);
                    if (void 0 !== logIdentity) record.logIdentity = logIdentity;
                }
                sessions.set(sessionId, record);
                installShadow(record);
                if (void 0 !== questions) questions.register(String(sessionId), connectionRef());
            }
            connectionRef().extNotification('_x.ai/mcp_initialized', {
                sessionId: String(sessionId)
            });
            await replaySession(sessionId, record.agent.session.events);
            pushAvailableCommands(record);
            return {};
        },
        async extMethod (method, params) {
            if (method.startsWith('_')) method = method.slice(1);
            if ('session/set_model' === method) {
                const { sessionId, modelId, _meta } = params;
                if ('string' != typeof sessionId || 'string' != typeof modelId) throw invalidParams('session/set_model requires sessionId and modelId');
                const record = requireSession(SessionId(sessionId));
                const route = await resolveModelRoute(ctx, modelId);
                if (void 0 === route) throw invalidParams(`model not found in any provider catalog: ${modelId}`);
                const resolved = await ctx.llm.resolveCallConfig(route);
                const effort = mapGrokEffort(_meta?.reasoningEffort);
                if (void 0 === record.modelSelectionRef) {
                    record.modelSelectionRef = {
                        current: void 0,
                        assembled: void 0
                    };
                    record.disposeModelSelection = installModelSelection(record.agent.ctx, record.modelSelectionRef);
                }
                const selection = {
                    provider: resolved.provider,
                    model: resolved.model,
                    ...void 0 === effort ? {} : {
                        reasoningEffort: ReasoningEffortId(effort)
                    }
                };
                record.modelSelectionRef.current = selection;
                const defaultModel = ctx.get('agentDefaultModel');
                if (void 0 !== defaultModel) try {
                    await defaultModel.saveSelection(selection);
                } catch (error) {
                    logger.warn(`grok-server: set_model wrote the session selection but not the shared default: ${String(error)}`);
                }
                if (void 0 !== lastModel && void 0 !== config.lastModelFile) {
                    lastModel.current = `${resolved.provider}${MODEL_ROUTE_SEPARATOR}${resolved.model}`;
                    persistLastModel(config.lastModelFile, lastModel.current);
                }
                return {};
            }
            if ('x.ai/session/list' === method) {
                const persistence = ctx.get('sessionPersistence');
                if (void 0 === persistence) return {
                    sessions: []
                };
                const requested = params.limit;
                const limit = Math.max(100, 'number' == typeof requested ? requested : 30);
                const archived = void 0 === config.storageRoot ? new Set() : await readArchivedSessionIds(config.storageRoot);
                const headers = [
                    ...await persistence.list()
                ].filter((header)=>!archived.has(String(header.id)));
                const { stat } = await import("node:fs/promises");
                const ranked = await Promise.all(headers.map(async (header)=>{
                    let lastActive = header.createdAt;
                    if (void 0 !== config.persistenceRoot) try {
                        const st = await stat(sessionLogPath(config.persistenceRoot, header.cwd, String(header.id)));
                        if (st.mtimeMs > lastActive) lastActive = st.mtimeMs;
                    } catch  {}
                    return {
                        header,
                        lastActive
                    };
                }));
                ranked.sort((a, b)=>b.lastActive - a.lastActive);
                const sessions = [];
                for (const { header, lastActive } of ranked.slice(0, limit)){
                    const firstPrompt = void 0 === config.persistenceRoot ? await firstUserPrompt(persistence, header) : await firstUserPromptFromLog(config.persistenceRoot, header) ?? await firstUserPrompt(persistence, header);
                    if (void 0 === firstPrompt) continue;
                    const autoTitle = void 0 === config.persistenceRoot ? void 0 : await sessionTitleFromLog(config.persistenceRoot, header);
                    const title = autoTitle ?? firstPrompt;
                    const iso = (ms)=>new Date(ms).toISOString();
                    sessions.push({
                        sessionId: String(header.id),
                        cwd: header.cwd ?? '',
                        createdAt: iso(header.createdAt),
                        updatedAt: iso(lastActive),
                        summary: title,
                        firstPrompt,
                        hostname: hostname(),
                        source: 'local',
                        title,
                        _meta: {
                            'x.ai/session': {
                                kind: 'chat'
                            }
                        }
                    });
                }
                return {
                    sessions,
                    nextCursor: null,
                    _meta: {
                        'x.ai/listScope': 'all'
                    },
                    meta: {
                        listScope: 'all'
                    }
                };
            }
            if ('x.ai/commands/list' === method) {
                const { sessionId } = params;
                if ('string' != typeof sessionId) return {
                    commands: []
                };
                const record = requireSession(SessionId(sessionId));
                return {
                    commands: toAvailableCommands(dshCommandsOf(record))
                };
            }
            if (method.startsWith('x.ai/')) return {};
            throw RequestError.methodNotFound(method);
        },
        extNotification (method, params) {
            return Promise.resolve();
        }
    };
    const alignWithSharedLog = async (record, sessionId)=>{
        if (void 0 === record.logIdentity || true === record.adopted || void 0 === config.persistenceRoot) return;
        const { stat } = await import("node:fs/promises");
        let current;
        try {
            const st = await stat(sessionLogPath(config.persistenceRoot, record.agent.session.header.cwd, String(sessionId)));
            current = {
                size: st.size,
                mtimeMs: st.mtimeMs
            };
        } catch  {
            current = void 0;
        }
        if (void 0 === current || current.size === record.logIdentity.size && current.mtimeMs === record.logIdentity.mtimeMs) return;
        logger.warn(`grok-server: session ${sessionId} was modified by another frontend — re-aligning before write`);
        const staleDispose = record.dispose;
        await staleDispose();
        const handle = await resumeWithRepair(sessionId);
        record.agent = handle.agent;
        record.dispose = ()=>handle.dispose();
        installShadow(record);
        if (void 0 !== questions) questions.register(String(sessionId), connectionRef());
        record.logIdentity = await logIdentityOf(handle.agent.session) ?? current;
        await replaySession(sessionId, record.agent.session.events);
        pushAvailableCommands(record);
    };
    async function replaySession(id, events) {
        const replayCalls = new Map();
        let usage = usageBySession.get(id);
        if (void 0 === usage) {
            usage = createUsageState();
            usageBySession.set(id, usage);
        }
        for (const event of events){
            const view = foldUsageWithView(usage, event);
            if (null !== view) notify(buildUsageUpdateNotification(id, view, event, true));
            for (const update of translateEvent(id, event, replayCalls, true, view ?? void 0))notify(update);
        }
    }
    const connection = new AgentSideConnection(()=>agent, channel.stream);
    conn = connection;
    const connectionRef = ()=>connection;
    connection.closed.catch((error)=>{
        logger.warn(`grok-server: connection closed with an error: ${String(error)}`);
    }).then(()=>quiesce()).catch((error)=>{
        logger.warn(`grok-server: connection teardown failed: ${String(error)}`);
    });
    let quiescing;
    const quiesce = ()=>{
        if (void 0 !== quiescing) return quiescing;
        closed = true;
        disposeEvents();
        disposeClaimed();
        disposeFlush();
        disposeApproval();
        disposeCommandsChange();
        const records = [
            ...sessions.values()
        ];
        sessions.clear();
        if (void 0 !== questions) for (const record of records)questions.unregister(String(record.agent.session.id));
        for (const record of records){
            record.disposeShadow?.();
            record.disposeModelSelection?.();
            if (true === record.adopted) {
                settlePrompt(record, 'cancelled');
                continue;
            }
            record.agent.cancel({
                kind: 'user'
            });
            settlePrompt(record, 'cancelled');
        }
        quiescing = (async ()=>{
            const disposals = await Promise.allSettled(records.map((record)=>record.dispose()));
            const failures = [];
            for (const result of disposals)if ('rejected' === result.status) failures.push(result.reason);
            if (failures.length > 0) throw new AggregateError(failures, `grok connection agent teardown failed for ${failures.length} session(s)`);
        })();
        return quiescing;
    };
    return {
        connection,
        dispose: quiesce
    };
}
function agentOptions(config, remembered) {
    const rememberedModel = remembered ?? config.model;
    if (void 0 === rememberedModel) return {};
    const at = rememberedModel.indexOf(MODEL_ROUTE_SEPARATOR);
    if (at > 0) return {
        provider: rememberedModel.slice(0, at),
        model: rememberedModel.slice(at + 1)
    };
    return {
        ...void 0 !== config.provider ? {
            provider: config.provider
        } : {},
        model: rememberedModel
    };
}
function validateSessionParams(params) {
    if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    if (void 0 !== params.additionalDirectories && params.additionalDirectories.length > 0) throw invalidParams('additionalDirectories is not supported');
}
const MODEL_ROUTE_SEPARATOR = '@';
async function modelState(ctx, config, remembered) {
    const effort = config.effort ?? 'max';
    const rows = [];
    const occurrences = new Map();
    for (const provider of ctx.llm.listProviders())try {
        const listed = await ctx.llm.listModels(provider.id);
        for (const model of listed){
            rows.push({
                provider: provider.id,
                modelId: model.id,
                name: model.name ?? model.id,
                ...await contextWindowFor(ctx, provider.id, model.id) ?? {}
            });
            occurrences.set(model.id, (occurrences.get(model.id) ?? 0) + 1);
        }
    } catch  {}
    const models = rows.map((row)=>{
        const duplicated = (occurrences.get(row.modelId) ?? 0) > 1;
        return {
            modelId: duplicated ? `${row.provider}${MODEL_ROUTE_SEPARATOR}${row.modelId}` : row.modelId,
            name: duplicated ? `${row.name} (${row.provider})` : row.name,
            ...duplicated ? {
                description: `provider: ${row.provider}`
            } : {},
            ...void 0 === row.contextWindow ? {} : {
                contextWindow: row.contextWindow
            }
        };
    });
    let selected = '';
    const rememberedModel = remembered;
    if (void 0 !== rememberedModel) {
        const at = rememberedModel.indexOf(MODEL_ROUTE_SEPARATOR);
        const bare = at > 0 ? rememberedModel.slice(at + 1) : rememberedModel;
        if (models.some((m)=>m.modelId === rememberedModel)) selected = rememberedModel;
        else if (models.some((m)=>m.modelId === bare)) selected = bare;
        else if ((occurrences.get(bare) ?? 0) > 1) {
            const preferred = config.provider ?? rows.find((r)=>r.modelId === bare)?.provider;
            const encoded = `${preferred ?? ''}${MODEL_ROUTE_SEPARATOR}${bare}`;
            selected = models.some((m)=>m.modelId === encoded) ? encoded : models[0]?.modelId ?? 'deepseek-v4-flash';
        } else selected = '';
    }
    if ('' === selected) {
        const target = config.model ?? models[0]?.modelId ?? 'deepseek-v4-flash';
        const duplicatedTarget = (occurrences.get(target) ?? 0) > 1;
        if (duplicatedTarget) {
            const preferred = config.provider ?? rows.find((r)=>r.modelId === target)?.provider;
            selected = `${preferred ?? ''}${MODEL_ROUTE_SEPARATOR}${target}`;
        } else selected = models.some((m)=>m.modelId === target) ? target : models[0]?.modelId ?? 'deepseek-v4-flash';
    }
    return {
        currentModelId: selected,
        availableModels: models.map((model)=>({
                ...model,
                _meta: {
                    supportsReasoningEffort: true,
                    reasoningEffort: effort,
                    ...void 0 === model.contextWindow ? {} : {
                        totalContextTokens: model.contextWindow
                    },
                    reasoningEfforts: [
                        {
                            id: 'off',
                            value: 'off',
                            label: 'Off',
                            description: 'No thinking',
                            default: 'off' === effort
                        },
                        {
                            id: 'high',
                            value: 'high',
                            label: 'High',
                            description: 'Standard reasoning',
                            default: 'high' === effort
                        },
                        {
                            id: 'max',
                            value: 'max',
                            label: 'Max',
                            description: 'Maximum reasoning',
                            default: 'max' === effort
                        }
                    ]
                }
            }))
    };
}
async function contextWindowFor(ctx, provider, model) {
    try {
        const resolved = await ctx.llm.resolveModelInfo(provider, model);
        return void 0 === resolved.context ? null : {
            contextWindow: resolved.context.contextWindow
        };
    } catch  {
        return null;
    }
}
async function resolveModelRoute(ctx, modelId) {
    const at = modelId.indexOf(MODEL_ROUTE_SEPARATOR);
    if (at > 0) {
        const provider = modelId.slice(0, at);
        const model = modelId.slice(at + 1);
        if (ctx.llm.listProviders().some((p)=>p.id === provider)) return {
            provider,
            model
        };
    }
    for (const info of ctx.llm.listProviders()){
        const provider = info.id;
        try {
            const listed = await ctx.llm.listModels(provider);
            if (listed.some((model)=>model.id === modelId)) return {
                provider,
                model: modelId
            };
        } catch  {}
    }
}
function mapGrokEffort(value) {
    if ('string' != typeof value) return;
    switch(value){
        case 'none':
        case 'minimal':
        case 'low':
        case 'medium':
            return 'off';
        case 'high':
        case 'xhigh':
            return 'high';
        case 'max':
            return 'max';
        default:
            return;
    }
}
function persistLastModel(path, model) {
    writeFile(path, model, 'utf8').catch(()=>{});
}
async function firstUserPrompt(persistence, header) {
    try {
        const { events } = await persistence.inspect(header.id);
        for (const event of events){
            if ('user/message' !== event.type) continue;
            const source = event.data.source;
            if ('user' !== source.kind) continue;
            const text = event.data.content.filter((block)=>'text' === block.type).map((block)=>block.text).join('').trim();
            if (text.length > 0) return text;
        }
    } catch  {}
}
function toGrokQuestion(item) {
    return {
        question: item.question,
        options: (item.options ?? []).map((option)=>({
                label: option.label,
                description: option.description ?? ''
            })),
        ...true === item.multiSelect ? {
            multiSelect: true
        } : {},
        ...void 0 !== item.header ? {
            id: item.header
        } : {}
    };
}
function mapAnswers(questions, answers, annotations) {
    return {
        answers: questions.map((question)=>{
            const key = question.question;
            const labels = answers[key] ?? [];
            const optionLabels = new Set((question.options ?? []).map((option)=>option.label));
            const selected = labels.filter((label)=>optionLabels.has(label));
            const notes = annotations?.[key]?.notes;
            const custom = void 0 !== notes && '' !== notes ? notes : labels.filter((label)=>!optionLabels.has(label)).join(', ');
            const item = {
                id: question.id,
                selected
            };
            if ('' !== custom) item.custom = custom;
            return item;
        })
    };
}
class QuestionRouter {
    sessions = new Map();
    register(sessionId, conn) {
        this.sessions.set(sessionId, conn);
    }
    unregister(sessionId) {
        this.sessions.delete(sessionId);
    }
    async ask(request) {
        const sessionId = void 0 === request.agent ? void 0 : String(request.agent.session.id);
        const conn = void 0 === sessionId ? void 0 : this.sessions.get(sessionId);
        if (void 0 === conn || void 0 === sessionId) throw new UserQuestionError('no grok client is attached to this session', 'NO_CLIENT');
        if (request.signal?.aborted) throw new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED');
        const payload = {
            sessionId,
            toolCallId: external_node_crypto_randomUUID(),
            questions: request.questions.map(toGrokQuestion),
            mode: request.questions.some((question)=>question.intent?.kind === 'plan-review') ? 'plan' : 'default'
        };
        let response;
        try {
            response = await conn.extMethod('_x.ai/ask_user_question', payload);
        } catch (error) {
            throw new UserQuestionError(`the grok client failed the question: ${String(error)}`, 'CLIENT_FAILED');
        }
        const typed = response;
        switch(typed.outcome){
            case 'accepted':
                return mapAnswers(request.questions, typed.answers ?? {}, typed.annotations);
            case 'chat_about_this':
            case 'skip_interview':
                throw new UserQuestionError(`the user chose "${typed.outcome}" instead of answering`, 'USER_DISMISSED');
            case 'cancelled':
                throw new UserQuestionError('the user dismissed this question', 'USER_DISMISSED');
            default:
                throw new UserQuestionError(`unexpected grok question outcome: ${String(typed.outcome)}`, 'CLIENT_FAILED');
        }
    }
}
const MAX_FRAME_BYTES = 67108864;
const DSH_BRIDGE_PREFIX = 'dsh-grok-tui';
const EVICT_GRACE_MS = 5000;
const EVICT_KILL_WAIT_MS = 2000;
const IDENTIFY_TIMEOUT_MS = 2000;
class LeaderConnection {
    socket;
    clientId;
    chunks = [];
    buffered = 0;
    closed = false;
    waiters = [];
    queue = [];
    constructor(socket){
        this.socket = socket;
        socket.on('data', (chunk)=>{
            this.#onData('string' == typeof chunk ? Buffer.from(chunk) : chunk);
        });
        socket.on('close', ()=>{
            this.closed = true;
            for (const waiter of this.waiters.splice(0))waiter(void 0);
        });
        socket.on('error', ()=>{});
    }
    #onData(chunk) {
        this.chunks.push(chunk);
        this.buffered += chunk.length;
        for(;;){
            const header = this.#peek(4);
            if (void 0 === header) return;
            const frameLen = header.readUInt32BE(0);
            if (frameLen > MAX_FRAME_BYTES) return void this.socket.destroy();
            const frame = this.#take(4 + frameLen);
            if (void 0 === frame) return;
            try {
                const message = JSON.parse(frame.subarray(4).toString('utf8'));
                const waiter = this.waiters.shift();
                if (void 0 !== waiter) waiter(message);
                else this.queue.push(message);
            } catch  {}
        }
    }
    #peek(n) {
        if (this.buffered < n) return;
        const out = Buffer.alloc(n);
        let offset = 0;
        for (const part of this.chunks){
            const take = Math.min(part.length, n - offset);
            part.copy(out, offset, 0, take);
            offset += take;
            if (offset >= n) break;
        }
        return out;
    }
    #take(n) {
        if (this.buffered < n) return;
        const out = Buffer.alloc(n);
        let offset = 0;
        while(offset < n){
            const part = this.chunks[0];
            if (void 0 === part) return;
            const take = Math.min(part.length, n - offset);
            part.copy(out, offset, 0, take);
            offset += take;
            this.buffered -= take;
            if (take === part.length) this.chunks.shift();
            else this.chunks[0] = part.subarray(take);
        }
        return out;
    }
    async next() {
        const queued = this.queue.shift();
        if (void 0 !== queued) return queued;
        if (this.closed) return;
        return new Promise((resolve)=>{
            this.waiters.push(resolve);
        });
    }
    send(message) {
        const data = Buffer.from(JSON.stringify(message), 'utf8');
        if (data.length > MAX_FRAME_BYTES) return;
        const header = Buffer.alloc(4);
        header.writeUInt32BE(data.length, 0);
        this.socket.write(Buffer.concat([
            header,
            data
        ]));
    }
    sendAcp(payload) {
        this.send({
            type: 'acp',
            payload
        });
    }
    close() {
        this.socket.end();
    }
}
function createLeaderServer(socketPath, onConnection, options = {}) {
    const { onFatal } = options;
    const fatal = (error)=>{
        if (void 0 !== onFatal) onFatal(error);
        else setImmediate(()=>{
            throw error;
        });
    };
    const servers = new Set();
    let boundInode;
    let binding = false;
    const bind = (conflictIsFatal)=>{
        const server = createServer((socket)=>onConnection(new LeaderConnection(socket)));
        servers.add(server);
        server.on('error', (error)=>{
            if ('EADDRINUSE' === error.code && conflictIsFatal) fatal(new Error(`another leader is already listening at ${socketPath}`));
        });
        binding = true;
        server.listen(socketPath, ()=>{
            binding = false;
            try {
                boundInode = statSync(socketPath).ino;
            } catch  {
                boundInode = void 0;
            }
        });
    };
    if (existsSync(socketPath)) {
        const probe = new Socket();
        probe.on('connect', ()=>{
            probe.destroy();
            takeover(socketPath, ()=>bind(true), fatal);
        });
        probe.on('error', ()=>{
            probe.destroy();
            try {
                unlinkSync(socketPath);
            } catch  {}
            bind(true);
        });
        probe.connect(socketPath);
    } else bind(true);
    const reclaimTimer = setInterval(()=>{
        if (binding) return;
        let current;
        try {
            current = statSync(socketPath).ino;
        } catch  {
            current = void 0;
        }
        if (void 0 !== current && current === boundInode) return;
        console.error(`grok-server: leader socket ${socketPath} was taken over (inode ${String(current)} != ${String(boundInode)}); reclaiming`);
        try {
            unlinkSync(socketPath);
        } catch  {}
        bind(false);
    }, options.reclaimIntervalMs ?? 5000);
    reclaimTimer.unref?.();
    return {
        dispose () {
            clearInterval(reclaimTimer);
            for (const server of servers)server.close();
            try {
                unlinkSync(socketPath);
            } catch  {}
        },
        path: socketPath
    };
}
function identifyLeader(socketPath) {
    return new Promise((resolve)=>{
        const socket = new Socket();
        let buffer = Buffer.alloc(0);
        let settled = false;
        const finish = (identity)=>{
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(identity);
        };
        const timer = setTimeout(()=>finish(void 0), IDENTIFY_TIMEOUT_MS);
        timer.unref?.();
        socket.on('connect', ()=>{
            const send = (message)=>{
                const data = Buffer.from(JSON.stringify(message), 'utf8');
                const header = Buffer.alloc(4);
                header.writeUInt32BE(data.length, 0);
                socket.write(Buffer.concat([
                    header,
                    data
                ]));
            };
            send({
                type: 'register',
                client_type: 'leader-identity-probe',
                mode: 'stdio',
                capabilities: {
                    client_version: '0.0.0-probe'
                }
            });
            send({
                type: 'control',
                request_id: 'identity-1',
                command: {
                    type: 'get_leader_info'
                }
            });
        });
        socket.on('data', (chunk)=>{
            buffer = Buffer.concat([
                buffer,
                chunk
            ]);
            while(buffer.length >= 4){
                const len = buffer.readUInt32BE(0);
                if (buffer.length < 4 + len) return;
                let message;
                try {
                    message = JSON.parse(buffer.subarray(4, 4 + len).toString('utf8'));
                } catch  {
                    buffer = buffer.subarray(4 + len);
                    continue;
                }
                buffer = buffer.subarray(4 + len);
                if ('control_result' !== message.type) continue;
                const ok = message.result.Ok;
                if (void 0 === ok) continue;
                const version = 'string' == typeof ok.leader_binary_version ? ok.leader_binary_version : '';
                const pid = 'number' == typeof ok.pid ? ok.pid : void 0;
                finish(version.startsWith(DSH_BRIDGE_PREFIX) ? {
                    kind: 'dsh-bridge',
                    pid,
                    version
                } : {
                    kind: 'foreign',
                    pid,
                    version
                });
            }
        });
        socket.on('error', ()=>finish(void 0));
        socket.connect(socketPath);
    });
}
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch  {
        return false;
    }
}
function waitForExit(pid, timeoutMs) {
    return new Promise((resolve)=>{
        const deadline = Date.now() + timeoutMs;
        const tick = ()=>{
            if (!isAlive(pid) || Date.now() >= deadline) return void resolve();
            setTimeout(tick, 100);
        };
        tick();
    });
}
async function evictLeader(pid) {
    try {
        process.kill(pid, 'SIGTERM');
    } catch  {
        return;
    }
    await waitForExit(pid, EVICT_GRACE_MS);
    if (!isAlive(pid)) return;
    try {
        process.kill(pid, 'SIGKILL');
    } catch  {
        return;
    }
    await waitForExit(pid, EVICT_KILL_WAIT_MS);
}
function findSocketOwnerPid(socketPath) {
    if ('linux' !== process.platform) return;
    try {
        let inode;
        for (const line of readFileSync('/proc/net/unix', 'utf8').split('\n')){
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 8 && parts[parts.length - 1] === socketPath) {
                inode = parts[6];
                break;
            }
        }
        if (void 0 === inode) return;
        for (const entry of readdirSync('/proc')){
            const pid = Number(entry);
            if (Number.isInteger(pid) && !(pid <= 0)) try {
                for (const fd of readdirSync(`/proc/${pid}/fd`))if (readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) return pid;
            } catch  {}
        }
    } catch  {}
}
async function takeover(socketPath, bind, fatal) {
    const identity = await identifyLeader(socketPath);
    if (identity?.kind === 'dsh-bridge') return void fatal(new Error(`another dsh web (grok-server) is already listening at ${socketPath}` + (void 0 === identity.pid ? '' : ` (pid ${identity.pid})`) + ' — stop it before starting a second host'));
    let pid = identity?.pid;
    if (void 0 === pid) pid = findSocketOwnerPid(socketPath);
    if (void 0 === identity && void 0 === pid) return void fatal(new Error(`a foreign leader is listening at ${socketPath} but its pid could not be identified; stop it manually and retry`));
    if (void 0 !== pid) {
        console.error(`grok-server: evicting foreign leader (pid ${pid}, ${identity?.version ?? 'unknown version'}) that holds ${socketPath}`);
        await evictLeader(pid);
    }
    try {
        unlinkSync(socketPath);
    } catch  {}
    bind();
}
const DEFAULT_HEALTH_INTERVAL_MS = 15000;
function startSessionHealthWatch(options) {
    const intervalMs = options.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    const lastSeen = new Map();
    let timer;
    let running = false;
    const tick = async ()=>{
        if (running) return void options.logger.warn('grok-server: session health pass still running from the previous interval — skipping this tick (store too large for the interval)');
        running = true;
        try {
            await tickCore();
        } finally{
            running = false;
        }
    };
    const tickCore = async ()=>{
        const now = Date.now();
        const paths = [];
        try {
            for await (const path of promises_glob(external_node_path_join(options.root, '*', '*', 'session.jsonl.zstd')))paths.push(path);
        } catch (error) {
            options.logger.warn(`grok-server: session health scan failed: ${String(error)}`);
            return;
        }
        for (const path of paths){
            let identity;
            try {
                const st = await promises_stat(path);
                identity = {
                    size: st.size,
                    mtimeMs: st.mtimeMs
                };
            } catch  {
                lastSeen.delete(path);
                continue;
            }
            if (now - identity.mtimeMs < 2 * intervalMs) continue;
            const previous = lastSeen.get(path);
            if (void 0 === previous || previous.size !== identity.size || previous.mtimeMs !== identity.mtimeMs) {
                try {
                    if (await detectInterleavedArtifact(path)) {
                        const fresh = await promises_stat(path);
                        if (fresh.size !== identity.size || fresh.mtimeMs !== identity.mtimeMs) continue;
                        if (await repairInterleavedArtifact(path)) options.logger.warn(`grok-server: session health watch repaired interleaved log ${path}`);
                    }
                } catch (error) {
                    options.logger.warn(`grok-server: session health check failed for ${path}: ${String(error)}`);
                }
                try {
                    const after = await promises_stat(path);
                    lastSeen.set(path, {
                        size: after.size,
                        mtimeMs: after.mtimeMs
                    });
                } catch  {
                    lastSeen.delete(path);
                }
            }
        }
    };
    timer = setInterval(()=>{
        tick();
    }, intervalMs);
    timer.unref?.();
    return {
        tick,
        dispose: ()=>{
            if (void 0 !== timer) clearInterval(timer);
            timer = void 0;
        }
    };
}
function acpChannel(conn) {
    let controller;
    let closed = false;
    const stream = {
        readable: new ReadableStream({
            start (inner) {
                controller = inner;
            },
            cancel () {
                closed = true;
            }
        }),
        writable: new WritableStream({
            write (message) {
                conn.sendAcp(JSON.stringify(message));
            }
        })
    };
    return {
        stream,
        push (payload) {
            if (closed || void 0 === controller) return;
            try {
                controller.enqueue(JSON.parse(payload));
            } catch  {}
        },
        close () {
            if (closed) return;
            closed = true;
            controller?.close();
        }
    };
}
const src_name = 'grok-server';
const inject = [
    'agents',
    'llm'
];
const Config = schemastery.object({
    socketPath: schemastery.string(),
    provider: schemastery.string(),
    model: schemastery.string(),
    effort: schemastery.string(),
    lastModelFile: schemastery.string(),
    persistenceRoot: schemastery.string(),
    storageRoot: schemastery.string(),
    webPort: schemastery.number(),
    userInteractionProvider: schemastery.boolean(),
    healthWatch: schemastery.boolean(),
    healthCheckIntervalMs: schemastery.number()
});
const SERVER_VERSION = 'dsh-grok-tui-0.1.0';
function apply(ctx, config) {
    const logger = ctx.logger;
    const socketPath = config.socketPath ?? process.env.GROK_LEADER_SOCKET ?? external_node_path_join(process.env.XDG_RUNTIME_DIR?.trim() || '/tmp', 'grok-leader.sock');
    const connections = new Set();
    const leaderConns = new Set();
    const questions = new QuestionRouter();
    let nextClientId = 1;
    const lastModel = {
        current: readLastModel(config)
    };
    const userQuestions = ctx.get('userQuestions');
    const registerAsProvider = config.userInteractionProvider ?? true;
    let disposeProvider;
    if (void 0 !== userQuestions && registerAsProvider) try {
        disposeProvider = userQuestions.registerProvider({
            ask: (request)=>questions.ask(request)
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.includes('DUPLICATE_PROVIDER')) logger.warn("grok-server: user-questions provider slot is already taken by another UI — grok questions keep riding the scoped shadow ask tools; the standalone provider registration was skipped");
        else throw error;
    }
    else if (void 0 !== userQuestions && !registerAsProvider) logger.info("grok-server: official-host mode (userInteractionProvider: false) — grok questions ride the scoped shadow ask tools; the web dialog serves web sessions");
    const server = createLeaderServer(socketPath, (connection)=>{
        handleConnection(connection);
    });
    logger.info(`grok-server: listening at ${server.path}; run the grok TUI with GROK_LEADER_SOCKET=${server.path} grok --leader`);
    function handleControl(conn, msg) {
        const { request_id: requestId, command } = msg;
        if (command?.type === 'get_leader_info') return void conn.send({
            type: 'control_result',
            request_id: requestId,
            result: {
                Ok: {
                    pid: process.pid,
                    socket_path: socketPath,
                    lock_path: `${socketPath}.lock`,
                    ws_url_suffix: '-dsh-grok-tui',
                    leader_protocol_version: 1,
                    leader_binary_version: SERVER_VERSION,
                    profiling_supported: false,
                    profiling_compiled_in: false,
                    cpu_profile_active: false,
                    profile_formats: []
                }
            }
        });
        conn.send({
            type: 'control_result',
            request_id: requestId,
            result: {
                Err: {
                    code: 'internal_error',
                    message: `control not supported by ${SERVER_VERSION}: ${command?.type ?? '?'}`
                }
            }
        });
    }
    async function handleConnection(conn) {
        leaderConns.add(conn);
        const channel = acpChannel(conn);
        const acp = createAcpAgent(ctx, config, channel, logger, questions, lastModel);
        connections.add(acp);
        try {
            for(;;){
                const message = await conn.next();
                if (void 0 === message) break;
                switch(message.type){
                    case 'register':
                        conn.clientId = nextClientId++;
                        conn.send({
                            type: 'registered',
                            client_id: conn.clientId,
                            ready: true,
                            leader_protocol_version: 1,
                            leader_binary_version: SERVER_VERSION,
                            leader_capabilities: {
                                control_v1: true
                            }
                        });
                        logger.info(`grok-server: client ${conn.clientId} registered (${message.client_type})`);
                        break;
                    case 'acp':
                        channel.push(message.payload);
                        break;
                    case 'ping':
                        conn.send({
                            type: 'pong'
                        });
                        break;
                    case 'control':
                        handleControl(conn, message);
                        break;
                    case 'disconnect':
                        conn.close();
                        break;
                }
            }
        } finally{
            leaderConns.delete(conn);
            channel.close();
            await acp.dispose();
            connections.delete(acp);
            logger.info('grok-server: client disconnected');
        }
    }
    ctx.effect(()=>()=>{
            for (const conn of leaderConns){
                conn.send({
                    type: 'shutting_down',
                    reason: 'manual',
                    delay_ms: 0
                });
                conn.close();
            }
            server.dispose();
            disposeProvider?.();
            for (const connection of connections)connection.dispose();
        }, 'grok-server.server');
    let healthWatch;
    if (void 0 !== config.persistenceRoot && (config.healthWatch ?? true)) {
        healthWatch = startSessionHealthWatch({
            root: config.persistenceRoot,
            ...void 0 === config.healthCheckIntervalMs ? {} : {
                intervalMs: config.healthCheckIntervalMs
            },
            logger: ctx.logger
        });
        ctx.effect(()=>()=>{
                healthWatch?.dispose();
            }, 'grok-server.health-watch');
    }
}
function readLastModel(config) {
    if (void 0 === config.lastModelFile) return;
    try {
        const value = readFileSync(config.lastModelFile, 'utf8').trim();
        return value.length > 0 ? value : void 0;
    } catch  {
        return;
    }
}
export { Config, apply, inject, src_name as name };
