# Alchemy65 README

This vscode extension adds syntax and debugger support for cc65 and ca65, especially for NES development. Currently **Alchemy65** supports debugging with Mesen-X, and support for more emulators is in progress.

## Features

**Debugs both C and assembly.**

![Set breakpoints and step through your code.](https://github.com/AlchemicRaker/alchemy65/raw/master/res/c-and-asm.png)

**Easily trace execution through macros.**

![Easily trace execution of macros.](https://github.com/AlchemicRaker/alchemy65/raw/master/res/macro-stack.png)

**Inline Build Errors and Warnings**, (enable these via the "bonus" setup step)

![Inline Build Errors and Warnings](https://github.com/AlchemicRaker/alchemy65/raw/master/res/build-output.png)

## Guide to Setting Up Debugging For Your Project

Projects already using cc65 can easily start using this extension. This guide assumes you have an NES project that uses cc65.

1. **Dependencies**
    1. Mesen-X is a maintained fork of Mesen. The latest builds of Mesen-X have been enhanced to support debugging in **Alchemy65**. Download and extract the build for your OS:
        * [Windows Build](https://github.com/NovaSquirrel/Mesen-X/actions/runs/1457182132)
        * [Linux Build](https://github.com/NovaSquirrel/Mesen-X/actions/runs/1457182135)
    2. The cc65 macro assembler, [available here](https://cc65.github.io/), can output **.dbg** files. Setting up **cc65** is an exercise left for the reader, but enabling the debug output is simple:
        * Use the `--dbgfile` option when calling the **ld65** linker.
        * Use the `-g` option with all calls to **ca65** and **cc65**.
        * Make sure the filenames for the rom and debug file match, like **foo.nes** and **foo.dbg**. This is how Mesen-X finds the **.dbg** file.
1. **Set Up Visual Studio Code**
    1. Visual Studio Code, [available here](https://code.visualstudio.com/), is a freely available and feature-full IDE, appropriate for NES homebrew. You will need it in order to use this extension.
    1. Navigate to "Extensions" (or `ctrl+shift+x`), search for "Alchemy65", and click **Install** to get this extension. You may also install it through [this marketplace link](https://marketplace.visualstudio.com/items?itemName=alchemic-raker.alchemy65).
        * Please note that in addition to debugging, this extension will add syntax hilighting for your NES project, for both assembly and c source.
1. **Set Up Your Project**
    1. After launching VSCode, use the "Open Folder" option to open the root directory of your NES project.
    1. From the "Run" menu, select "Add Configuration...".
        1. If it asks, select the "Alchemy65" option, which will allow you to **launch** mesen for debugging.
    1. Update the **"romPath"** and **"dbgPath"** to match the files you're building.
    1. Update **"program"** to point to the full or relative path to **mesen.exe**, or just to **"mesen"** if it's already in your **PATH**.
    1. **Optional / Bonus: Inline Build Errors and Warnings:** From the top menu select "Terminal" and "Configure Default Build Task" to generate a **tasks.json**. Remove that generated task and [replace it with this](res/sample-tasks.json) to have it parse the build output into VSCode. From now on you can use `ctrl+shift+b` to build your code.
1. **Start Debugging**
    1. Set a breakpoint in your code, maybe code in your game's main loop, by clicking next to the line numbers in your source code.
    1. From the "Run" menu, select "Start Debugging" (or `F5`).
        * Wait a moment for Mesen-X to launch, and then you should see the debugger center on the first instruction in your code (probably an `sei`?)
            * You can disable this behavior in the future by setting **"stopOnEntry": false** in your config.
        * Mesen opens it's own debug window, as well as it's own Script window. **Don't touch Mesen's debug window or Script window**, they are used by **Alchemy65** to communicate with Mesen.
    1. Press the "Continue" button on your debug controls. Your program should continue running, and stop again when it hits your breakpoint.
    1. End debugging by closing Mesen or using the "stop" debug control in VSCode.


## Requirements

**Alchemy65** works with the **.dbg** file generated cc65 / ca65 compilers. Remember to export your c symbols (Add the `-s` flag to **cc65**) if you want a better debugging experience in c source code.

**Alchemy65** currently only supports debugging through mesen-x, using a special lua script that allows **Alchemy65** to inspect and control the emulator. Support for other emulators is _possible_ if the necessary integration points are exposed (pause/resume, breakpoints, single-step execution, PC location in both CPU and PRG address space, memory inspection, and so on). 

Use "Add Configuration" to add sample **Alchemy65** Launch and Attach configurations to your **launch.json** file.

## Known Issues

* The C debugging experience is not quite as nice as the ASM debugging experience. The debugger "Steps" step through assembly instructions, not "whole C instructions". However in any assembly generated from C source, you may check the "C Source" in the "Call Stack" debug window.
  * For extensive debugging in C source, we recommend setting multiple breakpoints and continuing through them instead of stepping through instructions one by one.
* Watch "Expressions" are not full expressions. Instead these are simply symbol resolution, which means it only checks variable, function, and other scope identifiers. Symbols will evaluate to their values _at_ the symbol addresses. Some Symbols represent actual addresses or other constant values, these will be visible in trailing parentheses.

### Known Issues with Mesen-X

* Mesen's debugger is _very particular_. Using Mesen's debugger _and_ the **Alchemy65** debugger (e.g. setting breakpoints in both) is prone to unexpected behaviors.
  * When **Alchemy65** launches Mesen for debugging, the debug and script windows appear.

## Building Alchemy65

**Alchemy65** is in the VSCode Marketplace and ready to install without having to build it. But if you wish to build it yourself, it is not difficult. The only dependency is **npm**.

1. Clone this repository to your environment
2. Run `npm install` in the root folder
3. Run the extension in a new VSCode window with `F5`

## Release Notes

It's here!

### 1.0.0

Initial release of Alchemy65

