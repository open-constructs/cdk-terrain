/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { spawn } from "cross-spawn";
import { logger } from "@cdktn/commons";
import os from "os";

export interface InteractiveSpawnConfig {
  file: Parameters<typeof spawn>[0];
  args: Parameters<typeof spawn>[1];
  options: Parameters<typeof spawn>[2] & { cwd: string };
}

export interface InteractiveProcessActions {
  write: (response: string) => void;
  writeLine: (response: string) => void;
  stop: () => void;
}

export interface InteractiveProcess {
  // Always resolves, returns the exit code of the process
  exitCode: Promise<number>;
  actions: InteractiveProcessActions;
}

/**
 * A wrapper around child_process.spawn that handles the platform specific differences
 * and provide an intuitive API for bidirectional communication with the
 * spawned process.
 */
export function spawnInteractive(
  config: InteractiveSpawnConfig,
  onData: (data: string) => void,
): InteractiveProcess {
  const { args, options } = config;
  const file = config.file;

  const writable = process.stdin.writable;

  // Generally want interactive input for handling various prompts; however,
  // also need to be able to write specific responses, so create a pipe if not normally possible.
  options.stdio = [writable ? "inherit" : "pipe", "pipe", "pipe"];

  logger.trace(
    `Spawning process with file=${file}, args=${
      Array.isArray(args) ? `[${args.join(", ")}]` : `"${args}"`
    }, options=${JSON.stringify(options)}`,
  );

  const p = spawn(file, args, options);

  const actions: InteractiveProcessActions = {
    write: (response: string) => {
      logger.trace(
        `Sending response to process (file=${file}, args=${
          Array.isArray(args) ? `[${args.join(", ")}]` : `"${args}"`
        }): ${response}`,
      );
      p.stdin?.write(response);
    },
    writeLine: (response: string) => {
      logger.trace(
        `Sending response (with newline) to process (file=${file}, args=${
          Array.isArray(args) ? `[${args.join(", ")}]` : `"${args}"`
        }): ${response}`,
      );
      p.stdin?.write(`${response}${os.EOL}`);
    },
    stop: () => {
      logger.trace(
        `Aborting process (file=${file}, args=${
          Array.isArray(args) ? `[${args.join(", ")}]` : `"${args}"`
        })`,
      );
      p.kill();
    },
  };

  p.stdout?.on("data", (chunk: Buffer) => {
    onData(chunk.toLocaleString());
  });

  const exitCode = new Promise<number>((resolve) => {
    p.once("close", (code: number) => {
      if (code !== 0) {
        logger.debug(
          `Process (file=${file}, args=${
            Array.isArray(args) ? `[${args.join(", ")}]` : `"${args}"`
          }) exited with code ${exitCode}`,
        );
      }
      resolve(code);
    });
  });

  return { exitCode, actions };
}
