import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('pilot installer evidence and secret custody', () => {
  it('passes only a DPAPI bundle path to the installer child process', async () => {
    const validator = await source('pilot/validate-clean-install.ps1');
    expect(validator).toContain('-CredentialBundlePath $CredentialBundlePath');
    expect(validator).not.toMatch(/-InstallToken \$InstallToken|-GmailClientSecret \$GmailClientSecret|-QboSandboxClientSecret \$QboSandboxClientSecret/);
  });

  it('never allows a post-only F9 pass', async () => {
    const validator = await source('pilot/validate-clean-install.ps1');
    expect(validator).toContain("name='pre_report_present'; pass=$false");
    expect(validator).toContain("$prior.phase -ne 'pre'");
  });

  it('requires off-host recovery and verifies the copied DPAPI artifact', async () => {
    const installer = await source('pilot/install-pilot.ps1');
    expect(installer).toContain('RecoveryTarget is required');
    expect(installer).toContain('Recovery restore proof failed');
    expect(installer).toContain('recovery-proof.json');
    expect(installer).not.toMatch(/ENCRYPTION_KEY=.*Set-Content/);
  });

  it('gates the guided installer on verified external recovery instead of a checkbox', async () => {
    const core = await source('deploy/install-core.ps1');
    const gui = await source('deploy/install-gui.ps1');
    expect(core).toContain('RECOVERY_TARGET');
    expect(core).toContain('Test-ApHubExternalRecoveryTarget');
    expect(core).toContain('External recovery restore verification failed');
    expect(core).not.toMatch(/RecoveryKeyPath\s*=\s*Join-Path \$env:APPDATA/);
    expect(gui).toContain('$res.RecoveryVerified');
    expect(gui).not.toContain('I have saved my recovery key');
  });
});
