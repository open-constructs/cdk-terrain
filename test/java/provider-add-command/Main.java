/*
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

package com.mycompany.app;

import software.constructs.Construct;

import io.cdktn.cdktn.App;
import io.cdktn.cdktn.TerraformStack;
import io.cdktn.cdktn.Testing;
import io.cdktn.cdktn.LocalBackend;

public class Main extends TerraformStack
{
    public Main(final Construct scope, final String id) {
        super(scope, id);
    }

    public static void main(String[] args) {
        final App app = Testing.stubVersion(App.Builder.create().stackTraces(false).build());
        new Main(app, "java-simple");
        app.synth();
    }
}