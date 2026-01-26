module github.com/open-constructs/cdk-terrain/examples/go/docker

go 1.18

require (
	github.com/aws/constructs-go/constructs/v10 v10.4.3
	github.com/aws/jsii-runtime-go v1.119.0
	github.com/open-constructs/cdk-terrain-go/cdktn v0.0.0
)

require (
	github.com/Masterminds/semver/v3 v3.4.0 // indirect
	github.com/fatih/color v1.18.0 // indirect
	github.com/mattn/go-colorable v0.1.13 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/yuin/goldmark v1.4.13 // indirect
	golang.org/x/lint v0.0.0-20210508222113-6edffad5e616 // indirect
	golang.org/x/mod v0.27.0 // indirect
	golang.org/x/sync v0.16.0 // indirect
	golang.org/x/sys v0.35.0 // indirect
	golang.org/x/tools v0.36.0 // indirect
)

// only required when running example against cdk-terrain repo locally
replace github.com/open-constructs/cdk-terrain-go/cdktn => ../../../packages/cdktn/dist/go/cdktn
