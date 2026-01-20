/*
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

package com.mycompany.app.dataSources;

import io.cdktn.cdktn.TerraformStack;
import io.cdktn.cdktn.NamedRemoteWorkspace;
import software.constructs.Construct;

import imports.aws.provider.AwsProvider;
import imports.aws.provider.AwsProviderConfig;

// DOCS_BLOCK_START:data-sources-remote-state-data-source
import io.cdktn.cdktn.DataTerraformRemoteState;
import io.cdktn.cdktn.DataTerraformRemoteStateRemoteConfig;
import imports.aws.instance.Instance;
import imports.aws.instance.InstanceConfig;

public class DataSourcesRemoteState extends TerraformStack {

    public DataSourcesRemoteState(Construct scope, String id) {
        super(scope, id);
        // DOCS_BLOCK_END:data-sources-remote-state-data-source
        AwsProvider provider = new AwsProvider(this, "provider", AwsProviderConfig.builder()
                .region("us-east-1")
                .build());
        // DOCS_BLOCK_START:data-sources-remote-state-data-source

        // ....
        DataTerraformRemoteState remoteState = new DataTerraformRemoteState(this, "state",
                DataTerraformRemoteStateRemoteConfig.builder()
                        .organization("hashicorp")
                        .workspaces(new NamedRemoteWorkspace("vpc-prod"))
                        .build());

        new Instance(this, "foo", InstanceConfig.builder()
                // ....
                .subnetId(remoteState.getString("subnet_id"))
                .build());
    }
}
// DOCS_BLOCK_END:data-sources-remote-state-data-source
