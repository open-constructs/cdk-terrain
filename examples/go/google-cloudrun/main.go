// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

package main

import (
	"os"

	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"

	// Google provider packages.
	"github.com/cdktf/cdktf-provider-google-go/google/v16/cloudrunservice"
	"github.com/cdktf/cdktf-provider-google-go/google/v16/cloudrunserviceiampolicy"
	"github.com/cdktf/cdktf-provider-google-go/google/v16/datagoogleiampolicy"
	"github.com/cdktf/cdktf-provider-google-go/google/v16/provider"
)

// See https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloud_run_service#containers
type Container struct {
	Image string `json:"image"`
}

type Binding struct {
	Role    string   `json:"role"`
	Members []string `json:"members"`
}

func NewMyStack(scope constructs.Construct, id string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &id)

	// Set your project details.
	region := "europe-west1"
	projectID := "your-google-project-id" // e.g. plasma-goblin-123567

	// Hello World image.
	imageName := "gcr.io/cloudrun/hello"

	// Authenticate against Google.
	credentials, err := os.ReadFile("cdktf-example.json")
	if err != nil {
		panic("failed to load credentials: " + err.Error())
	}
	provider.NewGoogleProvider(stack, jsii.String("GoogleAuth"), &provider.GoogleProviderConfig{
		Region:      &region,
		Zone:        jsii.String(region + "-c"),
		Project:     &projectID,
		Credentials: jsii.String(string(credentials)),
	})

	crs := cloudrunservice.NewCloudRunService(stack, jsii.String("cloudRun"), &cloudrunservice.CloudRunServiceConfig{
		Location: &region,
		Name:     jsii.String("gcpcdktfcloudrunsvc2020"),
		Template: &cloudrunservice.CloudRunServiceTemplate{
			Spec: &cloudrunservice.CloudRunServiceTemplateSpec{
				// The "Containers" parameter type is just an interface{}.
				// So we have to provide our own type based on the documentation at:
				// https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloud_run_service#containers
				Containers: []Container{
					{
						Image: imageName,
					},
				},
			},
		},
	})

	policyData := datagoogleiampolicy.NewDataGoogleIamPolicy(stack, jsii.String("datanoauth"), &datagoogleiampolicy.DataGoogleIamPolicyConfig{
		Binding: []Binding{
			{
				Role:    "roles/run.invoker",
				Members: []string{"allUsers"},
			},
		},
	})

	cloudrunserviceiampolicy.NewCloudRunServiceIamPolicy(stack, jsii.String("runsvciampolicy"), &cloudrunserviceiampolicy.CloudRunServiceIamPolicyConfig{
		Location:   &region,
		Project:    crs.Project(),
		Service:    crs.Name(),
		PolicyData: policyData.PolicyData(),
	})

	cdktn.NewTerraformOutput(stack, jsii.String("cdktfcloudrunUrl"), &cdktn.TerraformOutputConfig{
		Value: *crs.Fqn(),
	})

	return stack
}

func main() {
	app := cdktn.NewApp(nil)
	NewMyStack(app, "learn-cdktf-docker")
	app.Synth()
}
