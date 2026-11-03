variable "name" {
  type = string
}

variable "instance_type" {
  description = "Used to pick an Availability Zone that actually offers this instance type."
  type        = string
}

variable "allowed_cidrs" {
  type = list(string)
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}
