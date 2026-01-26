package main

import (
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
)

func NewMyStack(scope constructs.Construct, id string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &id)

	// The code that defines your stack goes here

	return stack
}

func main() {
	app := cdktn.NewApp(nil)

	NewMyStack(app, "{{ $base }}")

	app.Synth()
}
