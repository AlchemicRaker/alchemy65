import { readFile } from 'fs/promises';

export type AddrSize = 'zeropage' | 'absolute';
export interface DbgMap {
    file: DbgFile[],
    line: DbgLine[],
    mod: DbgMod[],
    scope: DbgScope[],
    seg: DbgSeg[],
    span: DbgSpan[],
    sym: DbgSym[],
    type: DbgType[],
}

export interface DbgFile {
    id: number,
    name: string,
    size: number,
    mtime: string,
    mod: number[],
}

export interface DbgLine {
    id: number,
    file: number,
    line: number,
    type?: number,
    count?: number,
    span?: number[],
}

export interface DbgMod {
    id: number,
    name: string,
    file: number,
}

export interface DbgSeg {
    id: number,
    name: string,
    start: number, // hex address
    size: number, // hex size
    addrsize: AddrSize,
    type: 'rw' | 'ro',
    oname: string,
    ooffs: number,
}

export interface DbgSpan {
    id: number,
    seg: number,
    start: number,
    size: number,
    type?: number,
}

export interface DbgScope {
    id: number,
    name: string,
    mod: number,
    type?: 'scope',
    size?: number,
    parent?: number,
    sym?: number
    span?: number[]
}

export interface DbgSym {
    id: number,
    name: string,
    addrsize: AddrSize,
    size?: number,
    scope?: number,
    def: number[],
    ref?: number[],
    val?: string,
    seg?: number,
    type?: 'lab' | 'equ' | 'imp',
    exp?: number,
}

export interface DbgType {
    id: number,
    val: string,
}

function lineToData(line: string): {name:string, body:{[key: string]: string}} {
    const [name, kvps] = line.trim().split("\t");
    if(kvps === undefined) {
        const k = 5;
    }
    const kvp = kvps.split(',').map(s => {
        const [key, value] = s.split("=");
        return [key, value];
    });
    const body: {[key: string]: string} = Object.fromEntries(kvp);
    return {name, body};
}

function dataToFile(data: {[key: string]: string}): DbgFile {
    return {
        id: Number.parseInt(data.id),
        name: data.name,
        size: Number.parseInt(data.size),
        mtime: data.mtime,
        mod: data.mod.split("+").map(m => Number.parseInt(m)),
    };
}

function dataToLine(data: {[key: string]: string}): DbgLine {
    return {
        id: Number.parseInt(data.id),
        file: Number.parseInt(data.file),
        line: Number.parseInt(data.line),
        count: data.count ? Number.parseInt(data.count) : undefined,
        type: data.type ? Number.parseInt(data.type) : undefined,
        span: data.span ? data.span.split("+").map(s=>Number.parseInt(s)) : undefined,
    };
}

function dataToMod(data: {[key: string]: string}): DbgMod {
    return {
        id: Number.parseInt(data.id),
        file: Number.parseInt(data.file),
        name: data.name,
    };
}

function dataToScope(data: {[key: string]: string}): DbgScope {
    return {
        id: Number.parseInt(data.id),
        mod: Number.parseInt(data.mod),
        name: data.name,
        parent: data.parent ? Number.parseInt(data.parent) : undefined,
        size: data.size ? Number.parseInt(data.size) : undefined,
    };
}

function dataToSeg(data: {[key: string]: string}): DbgSeg {
    return {
        id: Number.parseInt(data.id),
        name: data.name,
        addrsize: <AddrSize> data.addrsize,
        oname: data.oname,
        ooffs: Number.parseInt(data.ooffs),
        size: parseInt(data.size.substr(2),16),
        start: parseInt(data.start.substr(2),16),
        type: <'ro'|'rw'> data.type,
    };
}

function dataToSpan(data: {[key: string]: string}): DbgSpan {
    return {
        id: Number.parseInt(data.id),
        seg: Number.parseInt(data.seg),
        size: Number.parseInt(data.size),
        start: Number.parseInt(data.start),
        type: data.type ? Number.parseInt(data.type) : undefined,
    };
}

function dataToSym(data: {[key: string]: string}): DbgSym {
    return {
        id: Number.parseInt(data.id),
        addrsize: <AddrSize> data.addrsize,
        def: data.def.split("+").map(s=>Number.parseInt(s)),
        name: data.name,
        exp: data.exp ? Number.parseInt(data.exp) : undefined,
        scope: data.scope ? Number.parseInt(data.scope) : undefined,
        seg: data.seg ? Number.parseInt(data.seg) : undefined,
        size: data.size ? Number.parseInt(data.size) : undefined,
        ref: data.ref ? data.ref.split("+").map(s=>Number.parseInt(s)) : undefined,
        type: data.type ? <'lab' | 'equ' | 'imp'> data.type : undefined,
        val: data.val,
    };
}

function dataToType(data: {[key: string]: string}): DbgType {
    return {
        id: Number.parseInt(data.id),
        val: data.val,
    };
}

export async function readDebugFile(path: string): Promise<DbgMap> {
	const debugFile = await readFile(path, "utf8");
    // split it into lines
    const [versionLine, infoLine, ...lineStrings] = debugFile.split("\n").filter(line => line.length>1);
    const lines = lineStrings.map(lineToData);
    const filterName = (fName: string) => lines.filter(({name})=>name===fName).map(({body})=>body);
    const map: DbgMap = { // TODO maybe, sort by id (should already be ordered)
        file: filterName("file").map(dataToFile),
        line: filterName("line").map(dataToLine),
        mod: filterName("mod").map(dataToMod),
        scope: filterName("scope").map(dataToScope),
        seg: filterName("seg").map(dataToSeg),
        span: filterName("span").map(dataToSpan),
        sym: filterName("sym").map(dataToSym),
        type: filterName("type").map(dataToType),
    };
    return map;
}

export function addressToSpans(dbg: DbgMap, address: number, cpuSpace: boolean): number[] {
    const segBase: (seg: DbgSeg) => number = (seg) => cpuSpace ? seg.start : seg.ooffs - 16;
    // find the segments containing the address
    const segments = dbg.seg.filter(seg => segBase(seg) <= address && address < segBase(seg) + seg.size).map(seg => seg.id);
    const spans = dbg.span.filter(span => {
        if (!segments.includes(span.seg)) {
            return false;
        }
        const segment = dbg.seg[span.seg];
        return segBase(segment) + span.start <= address && address < segBase(segment) + span.start + span.size;
    }).map(span => span.id);
    return spans;
}

export function spansToLines(dbg: DbgMap, spans: number[]): number[] {
    const lines = dbg.line.filter(line => {
        if (!line.span) {
            return false;
        }
        return line.span.findIndex(span => spans.includes(span)) !== -1;
    }).map(line => line.id);
    return lines;
}

