package com.mycompany.app;

import software.constructs.Construct;

import io.cdktn.cdktn.App;
import io.cdktn.cdktn.TerraformStack;


public class Main
{
    public static void main(String[] args) {
        final App app = new App();
        new MainStack(app, "{{ $base }}");
        app.synth();
    }
}