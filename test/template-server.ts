// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Zip, ZipDeflate } from "fflate";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { AddressInfo } from "net";

function addDirectory(zip: Zip, dir: string, prefix: string) {
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const zipPath = prefix ? `${prefix}/${entry}` : entry;
    if (fs.statSync(fullPath).isDirectory()) {
      addDirectory(zip, fullPath, zipPath);
    } else {
      const file = new ZipDeflate(zipPath, { level: 9 });
      zip.add(file);
      file.push(fs.readFileSync(fullPath), true);
    }
  }
}

export class TemplateServer {
  private server: http.Server;
  private static templateFile = "template.zip";

  constructor(private srcDirectory: string) {
    this.server = http.createServer(this.handle);
  }

  handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url !== `/${TemplateServer.templateFile}`) {
      res.statusCode = 404;
      res.end();
    }

    res.on("error", (err) => {
      throw err;
    });
    res.writeHead(200, {
      "Content-Type": "application/zip",
    });

    const zip = new Zip((err, data, final) => {
      if (err) {
        res.destroy(err);
        return;
      }
      res.write(data);
      if (final) {
        res.end();
      }
    });
    addDirectory(zip, this.srcDirectory, "");
    zip.end();
  };

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        this.server.listen(() => {
          const { port } = this.server.address() as AddressInfo;
          resolve(`http://localhost:${port}/${TemplateServer.templateFile}`);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
