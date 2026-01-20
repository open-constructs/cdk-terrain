/*
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

package com.mycompany.app;

import java.util.Arrays;
import java.util.ArrayList;

import io.cdktn.cdktn.App;
import io.cdktn.cdktn.TerraformOutput;
import io.cdktn.cdktn.TerraformStack;

import imports.azurerm.provider.*;
import imports.azurerm.virtual_network.*;

import software.constructs.Construct;

public class Main extends TerraformStack {
    public Main(final Construct scope, final String id) {
        super(scope, id);

        AzurermProvider.Builder.create(this, "AzureRm")
            .features(AzurermProviderFeatures.builder().build())
            .build();

        VirtualNetwork.Builder.create(this, "TfVnet")
            .location("uksouth")
            .addressSpace(Arrays.asList("10.0.0.0/24"))
            .name("TerraformVNet")
            .resourceGroupName("<YOUR_RESOURCE_GROUP_NAME>")
            .build();
    }

    public static void main(String[] args) {
        final App app = new App();
        new Main(app, "azure");
        app.synth();
    }
}