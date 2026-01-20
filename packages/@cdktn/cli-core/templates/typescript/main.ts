import { Construct } from "constructs";
import { App, TerraformStack } from "cdktn";

class MyStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // define resources here
  }
}

const app = new App();
new MyStack(app, "{{ $base }}");
app.synth();
