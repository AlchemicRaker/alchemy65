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
import { Message } from 'vscode-debugadapter/lib/messages';

import { fstat } from 'fs';
import { addressToSpans, DbgMap, DbgScope, readDebugFile, spansToScopes, spansToSpanLines } from './dbgService';
// import { Subject } from 'await-notify';
const PORT = 4064;

class AllStoppedEvent extends Event implements StoppedEvent {
	constructor(reason: string) {
		super("stopped");
		this.body = {
			reason,
		};
		this.allThreadsStopped = true;
	}
	body: { reason: string; };
	allThreadsStopped: boolean;
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
	public readonly socket: Socket;
	public readonly events: EventEmitter;
	constructor() {
		this.socket = new Socket();
		this.events = new EventEmitter();
		// this.events.on('isPaused', )
		this.connectPromise = new Promise((resolve) => {
			this.socket.on('connect', () => {
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
			console.log('connected');
		});
		this.socket.on('error', (err:Error) => {
			console.log(err);
		});
		this.socket.on('end', () => {
			console.log('end');
			this.events.emit('exit');
		});
		this.socket.on('close', () => {
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
	public pause() {
		this.socket.write("pause\n");
	}
	public resume() {
		this.socket.write("resume\n");
	}
	public reset() {
		this.socket.write("reset\n");
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

interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	romPath: string;
	dbgPath: string;
	mesenPath: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
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
	mesenPath: string;
}

export class Alchemy65DebugSession extends DebugSession {
	
	// private _configurationDone = new Subject();

	private alchemySocket?: AlchemySocket;
	private launchedSuccessfully: boolean;
	private config: Alchemy65Configuration;
	private debugFile?: DbgMap;

	public constructor(_session: vscode.DebugSession) {
		super();
		this.launchedSuccessfully = false;
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
		const symbol = this.debugFile.sym.find(s => s.name === symbolName && s.type !== "imp");

		const size = symbol && symbol.size ? symbol.size : 1;

		const {address, prgOffset, values} = await this.alchemySocket?.getLabel(label, Math.min(8, size));
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
		this.alchemySocket.events.on('isPaused', (isPaused: string) => {
			if(isPaused === "true") {
				this.sendEvent(new AllStoppedEvent('pause'));
				this.sendEvent(new StoppedEvent('pause',2));
				this.sendEvent(new StoppedEvent('pause',1));
			}
		});
		this.alchemySocket.events.on('stepped', () => {
			this.sendEvent(new AllStoppedEvent('step'));
			this.sendEvent(new StoppedEvent('step',2));
			this.sendEvent(new StoppedEvent('step',1));
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
	
	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		// await this._configurationDone.wait(1000);
		// await this.alchemySocket?.configuredPromise;
		let isConfigured = false;
		await Promise.race([this.alchemySocket?.configuredPromise.then(()=>isConfigured=true), timeout(1000)]);

		// start the program in the runtime
		// await this._runtime.start(args.program, !!args.stopOnEntry, !args.noDebug);

		if (!isConfigured) {
			// simulate a compile/build error in "launch" request:
			// the error should not result in a modal dialog since 'showUser' is set to false.
			// A missing 'showUser' should result in a modal dialog.
			this.sendErrorResponse(response, {
				id: 1001,
				format: `connection error: unable to connect to alchemy65 debug host`,
				showUser: true
			});
		} else {
			this.launchedSuccessfully = true;
			this.sendResponse(response);
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

	protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): void {
		this.alchemySocket?.stop();
		response.body = {};
		this.sendResponse(response);
		this.sendEvent(new TerminatedEvent());
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// only 1 or 2 threads, for the assembly and c stacks
		response.body = {
			threads: [
				new Thread(1, "c thread"),
				new Thread(2, "asm thread")
			]
		};
		this.sendResponse(response);
	}

	private stackFrames: {type: number, frame: DebugProtocol.StackFrame}[] = [];
	
	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
		if (!this.alchemySocket || !this.debugFile) {
			response.body = {
				stackFrames: []
			};
			this.sendResponse(response);
			return;
		}
		
		// for now, the stack is flat and only contains the pc
		const {pc, pcPrg} = await this.alchemySocket.getCpuVars();
		const address = pcPrg !== -1 ? pcPrg : pc;

		const spans = addressToSpans(this.debugFile, address, address === pc);
		
		const spanLines = spansToSpanLines(this.debugFile, spans);//.map(sl=>sl.line);
		if (spanLines.length <= 0) {
			response.body = {
				stackFrames: []
			};
			this.sendResponse(response);
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
						path: `C:\\repos\\01_Hello\\${filename}`,
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
			const pushVar = (name: string, value: number) => {
				response.body.variables.push({
					name, value: `${value}`,
					variablesReference: 0,
					memoryReference: "vmemref"
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
		const syms = this.debugFile.sym.filter(sym => sym.scope === args.variablesReference-10 );

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
				memoryReference: "vmemref",
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
		const workspace = "C:\\repos\\01_Hello\\";
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