import * as vscode from 'vscode';
import { ProviderResult, WorkspaceFolder } from 'vscode';
import { Alchemy65DebugSession } from './alchemy65Debug';

export function activateAlchemy65Debug(context: vscode.ExtensionContext) {
    
    context.subscriptions.push(vscode.commands.registerCommand("extension.alchemy65.getRomPath", _ => {
        const path = vscode.window.showOpenDialog({
            canSelectFiles: true,
            title: "Select the rom file to debug",
            openLabel: "Select rom file",
            filters: {
                "compiled nes files": ["nes"]
            }
        });//.then(result => result !== undefined && result.length > 0 ? result[0].path : undefined );
        return path;
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand("extension.alchemy65.getDbgPath", _ => {
        return vscode.window.showOpenDialog({
            canSelectFiles: true,
            title: "Select the dbg file to debug",
            openLabel: "Select dbg file",
            filters: {
                "cc65 debug files": ["dbg"]
            }
        });//.then(result => result !== undefined && result.length > 0 ? result[0].path : undefined );
    }));
    
    context.subscriptions.push(vscode.commands.registerCommand("extension.alchemy65.getMesenPath", _ => {
        return vscode.window.showOpenDialog({
            canSelectFiles: true,
            title: "Select mesen.exe",
            openLabel: "Select mesen.exe",
            filters: {
                "mesen executable": ["exe"]
            }
        });//.then(result => result !== undefined && result.length > 0 ? result[0].path : undefined );
    }));

    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('alchemy65', new Alchemy65ConfigurationProvider()));

	
	const factory: vscode.DebugAdapterDescriptorFactory = new InlineDebugAdapterFactory();
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('alchemy65', factory));
}

class Alchemy65ConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(_folder: WorkspaceFolder | undefined, config: vscode.DebugConfiguration, _token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			return vscode.window.showInformationMessage("Cannot find a launch.json").then(_config => {
				return undefined;	// abort launch
			});
			// const editor = vscode.window.activeTextEditor;
			// if (editor && editor.document.languageId === 'ca65') {
			// 	config.type = 'alchemy65';
			// 	config.name = 'Launch';
			// 	config.request = 'launch';
			// 	config.program = '${file}';
			// 	config.stopOnEntry = true;
			// }
		}

		if (!config.romPath) {
			return vscode.window.showInformationMessage("Cannot find a rom path").then(_config => {
				return undefined;	// abort launch
			});
		}

		if (!config.dbgPath) {
			return vscode.window.showInformationMessage("Cannot find a dbg path").then(_config => {
				return undefined;	// abort launch
			});
		}

		if (!config.mesenPath) {
			return vscode.window.showInformationMessage("Cannot find a mesen path").then(_config => {
				return undefined;	// abort launch
			});
		}

		return config;
	}
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new Alchemy65DebugSession(_session));
	}
}