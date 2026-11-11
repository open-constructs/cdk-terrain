# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

variable "iam_policy_statements" {
  description = "A list of IAM policy statements"
  type = list(object({  # TODO - change to map(object({...})) in next major version
    sid       = optional(string)
    actions   = optional(list(string))
    effect    = optional(string)
    resources = optional(list(string))
  }))
  default = null
}

variable "name" {
  description = "The name"
  type        = string
}

output "result" {
  value = "result"
}
