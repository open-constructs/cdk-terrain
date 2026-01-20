/*
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

package com.mycompany.app.remoteBackends;

// DOCS_BLOCK_START:remote-backend-define
import software.constructs.Construct;
import io.cdktn.cdktn.TerraformStack;
import io.cdktn.cdktn.App;
import io.cdktn.cdktn.CloudBackend;
import io.cdktn.cdktn.CloudBackendConfig;
import io.cdktn.cdktn.NamedCloudWorkspace;
import io.cdktn.cdktn.TerraformOutput;
import io.cdktn.cdktn.TerraformOutputConfig;

public class MainRemoteBackendDefine extends TerraformStack {

    public MainRemoteBackendDefine(Construct scope, String id) {
        super(scope, id);

        new CloudBackend(this, CloudBackendConfig.builder()
                .hostname("app.terraform.io")
                .organization("company")
                .workspaces(new NamedCloudWorkspace("my-app-prod"))
                .build()
        );

        new TerraformOutput(this, "dns-server", TerraformOutputConfig.builder()
                .value("hello-world")
                .build()
        );
    }
}
// DOCS_BLOCK_END:remote-backend-define