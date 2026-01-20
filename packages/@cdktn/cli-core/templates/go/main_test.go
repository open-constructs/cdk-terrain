package main

import (
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
	"testing"
)

// The tests below are example tests, you can find more information at
// https://cdk.tf/testing

/*
var stack = NewMyApplicationsAbstraction(cdktn.Testing_App(nil), "stack")
var synth = cdktn.Testing_Synth(stack)

func TestShouldContainContainer(t *testing.T){
	assertion := cdktn.Testing_ToHaveResource(synth, docker.Container_TfResourceType())

	if !*assertion  {
		t.Error("Assertion Failed")
	}
}

func TestShouldUseUbuntuImage(t *testing.T){
	properties := map[string]interface{}{
		"name": "ubuntu:latest",
	}
	assertion := cdktn.Testing_ToHaveResourceWithProperties(synth, docker.Image_TfResourceType(), &properties)

	if !*assertion  {
		t.Error("Assertion Failed")
	}
}

func TestCheckValidity(t *testing.T){
	assertion := cdktn.Testing_ToBeValidTerraform(cdktn.Testing_FullSynth(stack))

	if !*assertion  {
		t.Error("Assertion Failed")
	}
}
*/
