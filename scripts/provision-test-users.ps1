#requires -Version 7
# Provisions the integration-test user pool on the Cronus28 BC container.
# Idempotent: existing users are skipped. Safe to re-run.
#
# Usage:  pwsh ./scripts/provision-test-users.ps1
# Requires: bccontainerhelper module, Cronus28 container running.

$ErrorActionPreference = 'Stop'

$ContainerName = 'Cronus28'
$Tenant        = 'default'
$Password      = '1234'
$Users         = @('sshadows', 'bcmcp_test1', 'bcmcp_test2')

Import-Module bccontainerhelper -DisableNameChecking

$securePwd = ConvertTo-SecureString $Password -AsPlainText -Force
$existing  = Get-BcContainerBcUser -containerName $ContainerName -tenant $Tenant

foreach ($name in $Users) {
    $already = $existing | Where-Object { $_.UserName -ieq $name }
    if ($already) {
        Write-Host "[skip] user '$name' already exists"
        continue
    }
    Write-Host "[create] user '$name' (SUPER)"
    $cred = New-Object System.Management.Automation.PSCredential($name, $securePwd)
    New-BcContainerBcUser -containerName $ContainerName -tenant $Tenant `
        -Credential $cred `
        -PermissionSetId 'SUPER' `
        -ChangePasswordAtNextLogOn $false `
        -assignPremiumPlan
}

Write-Host ''
Write-Host 'Pool users present on Cronus28:'
Get-BcContainerBcUser -containerName $ContainerName -tenant $Tenant |
    Where-Object { $_.UserName -in $Users } |
    Select-Object UserName, State, LicenseType | Format-Table -AutoSize
