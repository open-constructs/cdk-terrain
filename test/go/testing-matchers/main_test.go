// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

package main

import (
	"testing"

	"cdk.tf/go/stack/generated/kreuzwerker/docker/config"
	"cdk.tf/go/stack/generated/kreuzwerker/docker/container"
	"cdk.tf/go/stack/generated/kreuzwerker/docker/datadockerimage"
	"cdk.tf/go/stack/generated/kreuzwerker/docker/datadockernetwork"
	docker "cdk.tf/go/stack/generated/kreuzwerker/docker/provider"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
)

var app = cdktn.Testing_App(nil)
var stack = NewMyStack(app, "stack")
var synth = cdktn.Testing_Synth(stack, jsii.Bool(false))
var fullSynth = cdktn.Testing_FullSynth(stack)

var stackInvalid = NewMyStackInvalid(app, "stack-invalid")
var fullSynthInvalid = cdktn.Testing_FullSynth(stackInvalid)

func TestToHaveResourcePass(t *testing.T) {
	assertion := cdktn.Testing_ToHaveResource(synth, container.Container_TfResourceType())

	if !*assertion {
		t.Error("Assertion Failed")
	}
}

func TestToHaveResourceFail(t *testing.T) {
	assertion := cdktn.Testing_ToHaveResource(synth, config.Config_TfResourceType())

	if *assertion {
		t.Error("Assertion Failed")
	}
}

func TestToHaveResourceWithPropertiesPass(t *testing.T) {
	properties := map[string]interface{}{
		"ports": &[]*container.ContainerPorts{{
			Internal: jsii.Number(80),
			External: jsii.Number(8000),
		}},
	}
	assertion := cdktn.Testing_ToHaveResourceWithProperties(synth, container.Container_TfResourceType(), &properties)

	if !*assertion {
		t.Error("Assertion Failed")
	}
}

func TestToHaveResourceWithPropertiesFail(t *testing.T) {
	properties := map[string]interface{}{
		"ports": &[]*container.ContainerPorts{{
			Internal: jsii.Number(100),
			External: jsii.Number(1000),
		}},
	}
	assertion := cdktn.Testing_ToHaveResourceWithProperties(synth, container.Container_TfResourceType(), &properties)

	if *assertion {
		t.Error("Assertion Failed")
	}
}

func TestToHaveDataPass(t *testing.T) {
	assertion := cdktn.Testing_ToHaveDataSource(synth, datadockerimage.DataDockerImage_TfResourceType())

	if !*assertion {
		t.Error("Assertion Failed")
	}
}
func TestToHaveDataFail(t *testing.T) {
	assertion := cdktn.Testing_ToHaveDataSource(synth, datadockernetwork.DataDockerNetwork_TfResourceType())

	if *assertion {
		t.Error("Assertion Failed")
	}
}
func TestToHaveDataWithPropertiesPass(t *testing.T) {
	properties := map[string]interface{}{
		"name": "nginx:latest",
	}
	assertion := cdktn.Testing_ToHaveDataSourceWithProperties(synth, datadockerimage.DataDockerImage_TfResourceType(), &properties)

	if !*assertion {
		t.Error("Assertion Failed")
	}
}
func TestToHaveDataWithPropertiesFail(t *testing.T) {
	properties := map[string]interface{}{
		"name": "wrong",
	}
	assertion := cdktn.Testing_ToHaveDataSourceWithProperties(synth, datadockerimage.DataDockerImage_TfResourceType(), &properties)

	if *assertion {
		t.Error("Assertion Failed")
	}
}

func TestToHaveProviderPass(t *testing.T) {

	assertion := cdktn.Testing_ToHaveProvider(synth, docker.DockerProvider_TfResourceType())

	if !*assertion {
		t.Error("Assertion Failed")
	}
}

func TestToBeValidTerraformPass(t *testing.T) {
	assertion := cdktn.Testing_ToBeValidTerraform(fullSynth)

	if !*assertion {
		t.Error("Assertion Failed")
	}
}

func TestToBeValidTerraformFail(t *testing.T) {
	assertion := cdktn.Testing_ToBeValidTerraform(fullSynthInvalid)

	if *assertion {
		t.Error("Assertion Failed")
	}
}
