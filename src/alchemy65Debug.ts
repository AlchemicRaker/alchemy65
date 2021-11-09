import * as vscode from 'vscode';
import { ProviderResult, WorkspaceFolder } from 'vscode';
import {
	Logger, logger,
	DebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent, InvalidatedEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, Event
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Socket } from 'net';
import { EventEmitter } from 'stream';
// import { Message } from 'vscode-debugadapter/lib/messages';

import { fstat } from 'fs';
import { access } from 'fs/promises';
import { addressToSpans, DbgMap, DbgScope, DbgSym, readDebugFile, spansToScopes, spansToSpanLines } from './dbgService';
import path = require('path');
import { ChildProcess, ChildProcessWithoutNullStreams, spawn } from 'child_process';
// import { Subject } from 'await-notify';
const PORT = 4064;

class AllStoppedEvent extends Event implements StoppedEvent {
	constructor(reason: string) {
		super("stopped");
		this.body = {
			reason,
			allThreadsStopped: true,
		};
	}
	body: { reason: string; allThreadsStopped: boolean; };
}
class ThreadStoppedEvent extends Event implements StoppedEvent {
	constructor(reason: string, threadId: number, preserveFocusHint: boolean) {
		super("stopped");
		this.body = {
			reason,
			threadId,
			preserveFocusHint,
		};
	}
	body: { reason: string, threadId: number, preserveFocusHint: boolean };
}

class ExitedEvent extends Event implements DebugProtocol.ExitedEvent {
	body: {
        exitCode: number
    };
	constructor(exitCode: number) {
        super('exited');
		this.body = {
			exitCode
		};
    }
}

class CustomProgressStartEvent extends Event implements DebugProtocol.ProgressStartEvent {
    body: {
        progressId: string;
        title: string;
		message?: string;
		percentage?: number;
    };
    constructor(progressId: string, title: string, message?: string, percentage?: number){
		super('progressStart');
        this.body = {
            progressId, title, message, percentage,
        };
	}
}

class CustomProgressUpdateEvent extends Event implements DebugProtocol.ProgressUpdateEvent {
	body: {
        progressId: string;
		message?: string;
		percentage?: number;
    };
    constructor(progressId: string, message?: string, percentage?: number) {
		super('progressUpdate');
        this.body = {
            progressId, message, percentage,
        };
	}
}

export function timeout(time: number) {
	return new Promise(resolve => setTimeout(resolve, time));
}

export async function waitForEvent(events: EventEmitter, eventName: string, time: number, fn: ()=>void): Promise<any[]> {
	return new Promise((resolve, reject) => {
		let fulfilled = false;
		const listener = (...args: any[]) => {
			if(fulfilled) {
				return;
			}
			fulfilled = true;
			resolve(args);
		};
		events.on(eventName, listener);
		setTimeout(() => {
			if(fulfilled) {
				return;
			}
			fulfilled = true;
			events.off(eventName, listener);
			reject();
		}, time);
		fn();
	});
}

interface CpuVars {
	status: number,
	a: number,
	x: number,
	y: number,
	pc: number,
	sp: number,
	pcPrg: number,
}

class AlchemySocket {
	public readonly connectPromise: Promise<void>;
	public readonly configuredPromise: Promise<void>;
	public socket: Socket;
	public readonly events: EventEmitter;
	public isConnected: boolean = false;
	constructor() {
		this.socket = new Socket();
		this.events = new EventEmitter();
		// this.events.on('isPaused', )
		this.connectPromise = new Promise((resolve) => {
			this.socket.once('connect', () => {
				resolve();
			});
		});
		this.configuredPromise = new Promise((resolve) => {
			this.events.on('configurationComplete', () => {
				// todo: resolve with the configuration data (paused, breakpoints, etc)
				resolve();
			});
		});
		this.socket.on('connect', () => {
			this.isConnected = true;
			console.log('connected');
		});
		this.socket.on('error', (err:Error) => {
			console.log(err);
		});
		this.socket.on('end', () => {
			this.isConnected = false;
			console.log('end');
			this.events.emit('exit');
		});
		this.socket.on('close', () => {
			this.isConnected = false;
			console.log('close');
			this.events.emit('exit');
		});
		this.socket.on('ready', () => {
			console.log('ready');
		});
		let dataBuffer: string = "";
		this.socket.on('data', (data: Buffer) => {
			dataBuffer = dataBuffer + data.toString();
			const messages = dataBuffer.split("\n");
			if(messages.length > 1) {
				// each message besides the last is an event
				for (let index = 0; index < messages.length-1; index++) {
					const message = messages[index];
					const [event, ...args] = message.split(" ");
					this.events.emit(event, ...args);
				}
				dataBuffer = messages[messages.length-1];
			}
		});
		this.socket.connect(PORT, "127.0.0.1");
	}
	public tryConnect() {
		this.socket.connect(PORT, "127.0.0.1");
	}
	public pause() {
		this.socket.write("pause\n");
	}
	public pauseCheck() {
		this.socket.write("pauseCheck\n");
	}
	public resume() {
		this.socket.write("resume\n");
	}
	public reset() {
		this.socket.write("reset\n");
	}
	public resetBreak() {
		this.socket.write("resetBreak\n");
	}
	public resetBreakNow() {
		this.socket.write("resetBreakNow\n");
	}
	public next() {
		this.socket.write("next\n");
	}
	public stop() {
		this.socket.end();
	}
	public async getCpuVars(): Promise<CpuVars> {
		const [status, a, x, y, pc, sp, pcPrg] = await waitForEvent(this.events, "cpuvars", 1000, 
			()=>this.socket.write("getcpuvars\n"));
		return {
			status: Number.parseInt(status), 
			a: Number.parseInt(a), 
			x: Number.parseInt(x), 
			y: Number.parseInt(y), 
			pc: Number.parseInt(pc), 
			sp: Number.parseInt(sp), 
			pcPrg: Number.parseInt(pcPrg),
		};
	}
	public async getLabel(label: string, bytes: number): Promise<{address: string, prgOffset: string, values: string[]}> {
		const [address, prgOffset, ...values] = await waitForEvent(this.events, `label-${label}`, 1000, 
			()=>this.socket.write(`getlabel ${label} ${bytes}\n`));
		return {address, prgOffset, values};
	}
	public setBreakpoints(breakpoints: {[key: string]: {cpu: number, prg: number}[]}) {
		const points = Object.values(breakpoints).flatMap(x => x);
		this.socket.write("clearbreakpoints\n");
		points.forEach(point => {
			this.socket.write(`setbreakpoint ${point.cpu} ${point.prg}\n`);
		});
	}
}

interface IAttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	dbgPath: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry: boolean;
	resetOnEntry: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** run without debugging */
	noDebug?: boolean;
	/** if specified, results in a simulated compile error in launch. */
	compileError?: 'default' | 'show' | 'hide';
}

interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	romPath: string;
	dbgPath: string;
	mesenPath: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry: boolean;
	resetOnEntry: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** run without debugging */
	noDebug?: boolean;
	/** if specified, results in a simulated compile error in launch. */
	compileError?: 'default' | 'show' | 'hide';
}

interface Alchemy65Configuration extends vscode.DebugConfiguration {
	dbgPath: string;
	romPath: string;
	program: string;
	sourcePath: string;
}

export class Alchemy65DebugSession extends DebugSession {
	
	// private _configurationDone = new Subject();

	private alchemySocket?: AlchemySocket;
	private launchedSuccessfully: boolean;
	private config: Alchemy65Configuration;
	private debugFile?: DbgMap;
	private context: vscode.ExtensionContext;
	private program: ChildProcessWithoutNullStreams | undefined;

	public constructor(context: vscode.ExtensionContext, _session: vscode.DebugSession) {
		super();
		this.launchedSuccessfully = false;
		this.context = context;
		// _session.configuration.request
		// handle 'launch' and 'attach'
		// const s = _session;
		//read in the dbg file from
		this.config = <Alchemy65Configuration> _session.configuration;
	}

	public async getSymbol(label: string): Promise<{address: string, prgOffset: string, value: string}> {
		if(!this.alchemySocket || !this.debugFile) {
			return {address: "-1", prgOffset: "-1", value: "-1"};
		}

		const symbolName = `"${label}"`;
		const cSymbolName = `"_${label}"`;

		const sym = this.debugFile.sym.find(s => (s.name === symbolName || s.name === cSymbolName) && s.type !== "imp");
		const csym = this.debugFile.csym.find(s => s.name === symbolName);

		if (!sym && !csym) {
			return {address: "-1", prgOffset: "-1", value: "-1"};
		}
		const symbol = sym !== undefined ? sym : csym?.sym !== undefined ? this.debugFile.sym[csym?.sym] : undefined;
		if (!symbol) {
			return {address: "-1", prgOffset: "-1", value: "-1"};
		}

		const size = symbol && symbol.size ? symbol.size : 1;

		const symbolLabel = symbolName.substr(1,symbolName.length-2);
		const {address, prgOffset, values} = await this.alchemySocket?.getLabel(symbolLabel, Math.min(8, size));
		if(values.length === 1 && values[0] === '') {
			
			if(symbol && symbol.val && symbol.val.length >= 3) {
				const valTrim = symbol.val.substr(2); // remove the 0x prefix
				const valPad = valTrim.length % 2 === 1 ? `0${valTrim}` : valTrim; // force an even number of chars
				const values = [];
				for (let i = 0; i < valPad.length; i+=2) {
					values.push(valPad.substr(i, 2));
				}
				return {address: "-2", prgOffset: "-1", value: values.join(" ")};
			}
			
			return {address: "-1", prgOffset: "-1", value: ""};
		}
		const renderValue = (d: string) => {
			const r = parseInt(d).toString(16).toUpperCase();
			return r.length < 2 ? `0${r}` : r;
		};
		const value = values.map(v => renderValue(v)).join(" ");
		const valueDecorate = size > 8 ? `${value} (...)` : value;
		return {address, prgOffset, value: valueDecorate};
	}
	
	protected async initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): Promise<void> {
		response.body = {
			supportsRestartRequest: true,
			supportsTerminateRequest: true,
			supportsConfigurationDoneRequest: true,
			supportsBreakpointLocationsRequest: true,
			supportsEvaluateForHovers: true,
		};
		
		const t = this;
		setTimeout(() => {
			// t.sendEvent(new StoppedEvent('exception', 2));
		});
		
		if(this.alchemySocket){
			this.alchemySocket.stop();
		}
		this.alchemySocket = new AlchemySocket();
		// this.alchemySocket.configuredPromise.then(() => {

			
		// });
		this.alchemySocket.events.on('exit',() => {
			// if not launched yet, show launch errors instead of terminating this way
			if(this.launchedSuccessfully){
				this.sendEvent(new TerminatedEvent(false));
			}
		});
		this.alchemySocket.events.on('isPaused', async (isPaused: string) => {
			if(isPaused === "true") {
				// if there's c code, go there, otherwise go to asm
				await this.refreshStackFrames();
				const cpuAvailable = this.stackFrames.findIndex(f => f.type === 1) !== -1;
				this.sendEvent(new ThreadStoppedEvent('pause', 1, !cpuAvailable));
				this.sendEvent(new ThreadStoppedEvent('pause', 2, cpuAvailable));
			}
		});
		this.alchemySocket.events.on('stepped', async () => {
			await this.refreshStackFrames();
			const cpuAvailable = this.stackFrames.findIndex(f => f.type === 1) !== -1;
			this.sendEvent(new ThreadStoppedEvent('step', 1, !cpuAvailable));
			this.sendEvent(new ThreadStoppedEvent('step', 2, cpuAvailable));
		});
		// TODO: wait for the socket to connect
		try{
			this.debugFile = await readDebugFile(this.config.dbgPath);
		} catch(e) {
			//can't find file
			// this.sendEvent(new TerminatedEvent());
			this.sendErrorResponse(response, {
				id: 1001,
				format: `resource error: unable to find or load dbg file`,
				showUser: true
			});
			return;
		}
		
		
		this.sendResponse(response);
		this.sendEvent(new InitializedEvent());
	}
	
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		const x = 5;
		// notify the launchRequest that configuration has finished
		// this._configurationDone.notify();
	}

	protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments, request?: DebugProtocol.Request): Promise<void> {
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		let isConfigured = false;
		let retry = 0;
		const retryLimit = 4;

		const progressStart = new CustomProgressStartEvent("attaching", "Establishing connection with debugger...", undefined, 0);

		this.sendEvent(progressStart);
		while(retry < retryLimit) {
			await Promise.race([
				this.alchemySocket?.configuredPromise.then(()=>isConfigured=true), 
				timeout(500),
			]);

			if(isConfigured) {
				break;
			}
			const progressUpdate = new CustomProgressUpdateEvent("attaching", undefined, 1/retryLimit*retry);
			this.sendEvent(progressUpdate);

			this.alchemySocket?.tryConnect();

			retry++;
		}
		this.sendEvent(new ProgressEndEvent("attaching"));
		
		if(!isConfigured) {
			this.sendErrorResponse(response, {
				id: 1001,
				format: `connection error: unable to connect to alchemy65 debug host`,
				showUser: true
			});
			return;
		}
		this.launchedSuccessfully = true;
		this.sendResponse(response);
		this.alchemySocket?.setBreakpoints(this.breakpoints);
		if(args.resetOnEntry && args.stopOnEntry) {
			this.alchemySocket?.resetBreak();
		} else if (args.resetOnEntry) {
			this.alchemySocket?.reset();
		} else if (args.stopOnEntry) {
			this.alchemySocket?.pause();
		}
		this.alchemySocket?.pauseCheck();
	}
	
	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		const programExists = await access(this.config.program).then(()=>true).catch(()=>false);
		if(!programExists) {
			this.sendErrorResponse(response, {
				id: 1001,
				format: `launch error: unable to locate emulator`,
				showUser: true
			});
			return;
		}
		const spawnArgs = [
			this.config.romPath,
			this.context.asAbsolutePath("lua/adapter.lua"),
		];
		this.program = spawn(this.config.program, spawnArgs);

		let isConfigured = false;
		let retry = 0;
		const retryLimit = 60;

		const progressStart = new CustomProgressStartEvent("attaching", "Establishing connection with debugger...", undefined, 0);

		this.sendEvent(progressStart);
		while(retry < retryLimit) {
			await Promise.race([
				this.alchemySocket?.configuredPromise.then(()=>isConfigured=true), 
				timeout(500),
			]);

			if(isConfigured) {
				break;
			}
			const progressUpdate = new CustomProgressUpdateEvent("attaching", undefined, 1/retryLimit*retry);
			this.sendEvent(progressUpdate);

			this.alchemySocket?.tryConnect();

			retry++;
		}
		this.sendEvent(new ProgressEndEvent("attaching"));
		
		if (!isConfigured) {
			this.sendErrorResponse(response, {
				id: 1001,
				format: `connection error: unable to connect to alchemy65 debug host`,
				showUser: true
			});
		} else {
			this.launchedSuccessfully = true;
			this.sendResponse(response);
			if(args.resetOnEntry && args.stopOnEntry) {
				this.alchemySocket?.resetBreak();
				this.alchemySocket?.setBreakpoints(this.breakpoints);
			} else if (args.resetOnEntry) {
				this.alchemySocket?.setBreakpoints(this.breakpoints);
				this.alchemySocket?.reset();
			} else if (args.stopOnEntry) {
				this.alchemySocket?.setBreakpoints(this.breakpoints);
				this.alchemySocket?.pause();
			} else {
				this.alchemySocket?.setBreakpoints(this.breakpoints);
			}
		}
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request): void {
		this.alchemySocket?.resume();
		response.body = {};
		this.sendResponse(response);
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): void {
		this.alchemySocket?.pause();
		response.body = {};
		this.sendResponse(response);
	}

	protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void {
		this.alchemySocket?.reset();
		response.body = {};
		this.sendResponse(response);
	}

	protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): Promise<void> {
		this.alchemySocket?.stop();
		response.body = {};
		this.sendResponse(response);
		this.sendEvent(new TerminatedEvent());
	}

	protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): Promise<void> {
		this.alchemySocket?.stop();
		response.body = {};
		this.sendResponse(response);
		if(this.program) {
			const program = this.program;
			try{
				const waitUntilClose = new Promise<void>((resolve) => {
					program.on("close",() => resolve());
					setTimeout(()=>resolve(),10*1000);
				});
				
				this.program.kill();

				await waitUntilClose;
			}catch(e) {

			}
		}
		this.sendEvent(new TerminatedEvent());
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// only 1 or 2 threads, for the assembly and c stacks
		response.body = {
			threads: [
				new Thread(1, "c source"),
				new Thread(2, "asm source")
			]
		};
		this.sendResponse(response);
	}

	private stackFrames: {type: number, frame: DebugProtocol.StackFrame}[] = [];

	protected async refreshStackFrames(): Promise<void> {
		if (!this.alchemySocket || !this.debugFile) {
			this.stackFrames = [];
			return;
		}
		
		// for now, the stack is flat and only contains the pc
		const {pc, pcPrg} = await this.alchemySocket.getCpuVars();
		const address = pcPrg !== -1 ? pcPrg : pc;

		const spans = addressToSpans(this.debugFile, address, address === pc);
		
		const spanLines = spansToSpanLines(this.debugFile, spans);//.map(sl=>sl.line);
		if (spanLines.length <= 0) {
			this.stackFrames = [];
			return;
		}
		if (spanLines.length > 1) {
			const wait = 1;
		}

		const childFinder: (scopes: DbgScope[]) => DbgScope | undefined = (scopes) => {
			return scopes.find(scope => {
				return scopes.findIndex(s => scope.id === s.parent) === -1;
			});
		};

		const unorderedFrames: {type: number, frame: DebugProtocol.StackFrame}[] = spanLines.map((spanLine, index) => {
			const {line, spans} = spanLine;
			const scopes = spansToScopes((<DbgMap>this.debugFile), spans.map(s=>s.id));
			const topScope = childFinder(scopes);
			const file = (<DbgMap>this.debugFile).file[line.file];
			const filename = file.name.substr(1,file.name.length-2);
			const type = line.type || -1;
			const descriptor = type === -1 ? "(asm)"
							 : type === 1 ? ` (c)`
							 : type === 2 ? ` (macro)` // TODO: load the line to show as hint
							 : ` (${type})`;
			const name = topScope !== undefined ? `${topScope.name}${descriptor}` : `line ${line.line}${descriptor}`;

			return {
				frame: {
					column: 0,
					line: line.line,
					id: line.id,
					name,
					presentationHint: 'normal', //type === -1 ? 'normal' : 'subtle',
					source: {
						name: filename,
						path: path.join(this.config.sourcePath, filename),
					}
				},
				type,
			};
		});

		const orderedFrames = unorderedFrames.sort(({type:a},{type:b})=>{
			if(a === 1) { return -1; }
			if(b === 1) { return 1; }

			return a<b?-1:a>b?1:0;
		});

		this.stackFrames = orderedFrames;
	}
	
	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
		//TODO: only update when necessary
		await this.refreshStackFrames();

		const filteredFrames = this.stackFrames.filter(sf => {
			if(args.threadId === 1) {
				return sf.type === 1;
			} else if(args.threadId === 2) {
				return sf.type !== 1;
			} else {
				const x = 5;
				return true;
			}
		}).map(f => f.frame);
		
		response.body = { // TODO: order these stack frames, preferring primary source (line.type undefined)
			stackFrames: filteredFrames,
			totalFrames: filteredFrames.length,
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		//find what scopes intersect with
		// args.frameId -- stackframe reference
		const frameLine = this.stackFrames.find(frame => frame.frame.id === args.frameId);
		if (!this.alchemySocket || !this.debugFile || frameLine === undefined) {
			response.body = {
				scopes: [new Scope("CPU", 2, true)]
			};
			this.sendResponse(response);
			return;
		}

		//get the line's segment(s) for a point of reference
		const line = this.debugFile.line[frameLine.frame.id];
		const lineSpans = (line.span || []).map(span => (<DbgMap>this.debugFile).span[span]);

		// const lineSegs = frameLine.

		const scopes = spansToScopes(this.debugFile, line.span || []).map(scope => {
			const name = scope.name.substr(1,scope.name.length-2);
			const prettyName = name.length > 0 ? name : "(top)";
			const mod = (<DbgMap>this.debugFile).mod[scope.mod];
			return new Scope(`${mod.name.substr(1,mod.name.length-2)}-${prettyName}`,scope.id+10,true); //variable reference 0 is reserved
		});

		response.body = {
			scopes: [
				// new Scope("Locals", 1, true),
				new Scope("CPU", 2, true),
				// new Scope("RAM", 3, true),
				...scopes,
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
		if (!this.alchemySocket?.events || !this.debugFile) {
			response.body = {variables: []};
			this.sendResponse(response);
			return;
		}

		if (args.variablesReference === 2) { // CPU
			// request CPU info
			const {a, x, y, pc, sp, status} = await this.alchemySocket.getCpuVars();
			response.body = {
				variables: []
			};
			const numToPrettyHex: (n:number) => string = (n) => {
				const hex = n.toString(16).toUpperCase();
				if(hex.length % 2 === 1) {
					return `0${hex}`;
				}
				return hex;
			};
			const pushVar = (name: string, value: number) => {
				response.body.variables.push({
					name, value: numToPrettyHex(value),
					variablesReference: 0,
					type: "string",
				});
			};
			pushVar("a", a);
			pushVar("x", x);
			pushVar("y", y);
			pushVar("pc", pc);
			pushVar("sp", sp);
			pushVar("status", status);
			this.sendResponse(response);
			return;
		}
		// if (args.variablesReference === 3) { // RAM (anything labeled, including ranges? nest these?)
		// 	// request RAM info
		// 	const irqTableAddress = await this.alchemySocket.getLabel("irq_table_address");
		// 	const main = await this.alchemySocket.getLabel("main");
		// 	response.body = {
		// 		variables: []
		// 	};
		// 	const pushVar = (name: string, value: string) => {
		// 		response.body.variables.push({
		// 			name, value,
		// 			variablesReference: 0,
		// 			memoryReference: "vmemref"
		// 		});
		// 	};
		// 	pushVar("irq_table_address", irqTableAddress.value);
		// 	pushVar("main", main.value);
		// 	this.sendResponse(response);
		// 	return;
		// }

		// look up all symbols in the scope
		const variables:DebugProtocol.Variable[] = [];

		const debugFile: DbgMap = this.debugFile;
		const csyms = this.debugFile.csym.filter(csym => csym.scope === args.variablesReference-10 ); 
		const syms = [
			...this.debugFile.sym.filter(sym => sym.scope === args.variablesReference-10 ),
			...csyms.map(csym => debugFile.sym[csym.sym]),
		].reduce((a,b) => a.findIndex(ae => ae.id === b.id) !== -1 ? a : [...a, b], <DbgSym[]>[]);

		for (let index = 0; index < syms.length; index++) {
			const sym = syms[index];
			// // if the symbol is nestable (a struct), allow it to be explored
			// if(sym.scope){
			// 	const scope = this.debugFile.scope[sym.scope];
			// 	if(scope.type === "struct") {
			// 		variables.push({
			// 			name: sym.name.substr(1,sym.name.length-2),
						
			// 		})
			// 	}
			// }
			const v = await this.getSymbol(sym.name.substr(1,sym.name.length-2));
			if (v.address === "-1") {
				continue;
			}
			variables.push({
				name: sym.name.substr(1,sym.name.length-2),
				value: v.value,
				variablesReference: 0,
				type: 'string',
				evaluateName: sym.name.substr(1,sym.name.length-2)
			});
		}


		// args.
		response.body = {
			variables
		};
		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request): Promise<void> {
		if (!this.alchemySocket?.events) {
			response.body = {result: "N/A", variablesReference: 0};
			this.sendResponse(response);
			return;
		}

		const expression = await this.getSymbol(args.expression);
		if(expression.address === "-1") {
			response.success = false;
			return this.sendResponse(response);
		}
		response.body = {
			result: expression.value,
			variablesReference: 0
		};
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request): void {
		this.alchemySocket?.next();
		response.body = {};
		this.sendResponse(response);
	}

	private breakpoints: {[key: string]: {cpu: number, prg: number}[]} = {};

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		if (!this.alchemySocket || !this.debugFile || !args.breakpoints || !args.source.path) {
			response.body = {
				breakpoints: [],
			};
			this.sendResponse(response);
			return;
		}
		
		//clear debugger breakpoints for this source and assign new ones
		//TODO: this is terrible
		const workspace = this.config.sourcePath;
		const normalizePath = args.source.path.substr(workspace.length).replace("\\","/");
		const file = this.debugFile.file.find(file => file.name === `"${normalizePath}"`);

		if (!file) {
			response.body = {
				breakpoints: [],
			};
			this.sendResponse(response);
			return;
		}

		const spans = args.breakpoints.flatMap(breakpoint => {
			const findLine = breakpoint.line;
			const spans = (<DbgMap>this.debugFile).line.filter(line => line.line === findLine).flatMap(line=>line.span);
			
			return <number[]> spans.filter(span => span !== undefined);
		});

		const nesbreaks: {cpu: number, prg: number}[] = spans.map(s => {
			const span = (<DbgMap>this.debugFile).span[s];
			const seg = (<DbgMap>this.debugFile).seg[span.seg];
			let ret: {cpu: number, prg: number} | undefined = undefined;
			if(seg.ooffs !== undefined) {
				ret = {
					cpu: seg.start + span.start,
					prg: seg.ooffs - 16 + span.start,
				};
			} else {
				ret = {
					cpu: seg.start + span.start,
					prg: -1,
				};
			}
			return ret;
		});

		this.breakpoints[args.source.path] = nesbreaks;
		
		this.alchemySocket.setBreakpoints(this.breakpoints);

		response.body = {
			breakpoints: args.breakpoints.map(() => {
				return {
					verified: true, // we're optimistic
				};
			}),
		};
		this.sendResponse(response);
	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {
		if (!this.alchemySocket || !this.debugFile || !args.source.path) {
			response.body = {
				breakpoints: [],
			};
			this.sendResponse(response);
			return;
		}
		const file = this.debugFile.file.find(file => file.name === `"${args.source.path}"`);
		if(!file){
			response.body = {
				breakpoints: [],
			};
			this.sendResponse(response);
			return;
		}
		const startLine = args.line;
		const endLine = args.endLine ? args.endLine : args.line;
		const lines = this.debugFile.line.filter(line => {
			return line.file === file.id && line.line >= startLine && line.line <= endLine;
		});
		response.body = {
			breakpoints: lines.map(line => {
				return {
					line: line.line
				};
			})
		};
		this.sendResponse(response);
	}
}