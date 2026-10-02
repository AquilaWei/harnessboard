// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { riskOf } from '../src/risk.js';

const WT = '/work/wt-1';
const bash = (command: string) => riskOf('Bash', { command }, WT);

describe('riskOf allows ordinary work', () => {
  it.each([
    'npm test',
    'echo hi > notes.txt',
    'make 2>/dev/null >/dev/null',
    'git push origin main',
    'git reset --hard HEAD~1',
    'sudo apt install jq',
    'curl https://example.com -o out.html',
    'docker ps',
    'npm publish',
    'cd .. && ls',
    'rm old.txt',
    'rm -rf build',
    'rm -rf node_modules dist',
    'echo x > /tmp/scratch.txt',
    'git commit -m "reboot the board"',
  ])('%s', (command) => {
    expect(bash(command)).toBeNull();
  });
});

describe('riskOf for commands that wipe the system or home', () => {
  it.each(['rm -rf /', 'rm -rf /*', 'rm -rf ~', 'rm -rf ~/', 'rm -fr $HOME', 'sudo rm -rf /'])(
    '%s',
    (command) => {
      expect(bash(command)).toBe('deletes the system or your home directory');
    },
  );

  it('is caught after another command', () => {
    expect(bash('cd build && rm -rf /')).toBe('deletes the system or your home directory');
  });

  it('is caught with --no-preserve-root', () => {
    expect(bash('rm -r --no-preserve-root /')).toBe('deletes the system or your home directory');
  });

  it('is caught for a system directory', () => {
    expect(bash('rm -rf /etc')).toBe('deletes the system or your home directory');
  });
});

describe('riskOf for recursive deletes outside the worktree', () => {
  it('asks about another project', () => {
    expect(bash('rm -rf /work/other')).toBe("deletes recursively outside the task's worktree");
  });

  it('asks about a folder in the home directory', () => {
    expect(bash('rm -rf ~/Documents')).toBe("deletes recursively outside the task's worktree");
  });

  it('asks about a path that climbs out', () => {
    expect(bash('rm -rf ../wt-2')).toBe("deletes recursively outside the task's worktree");
  });

  it('allows deleting a single file elsewhere', () => {
    expect(bash('rm /tmp/old.txt')).toBeNull();
  });
});

describe('riskOf for disks and shutdown', () => {
  it('asks before formatting', () => {
    expect(bash('mkfs.ext4 /dev/sda1')).toBe('writes to a disk');
  });

  it('asks before dd to a device', () => {
    expect(bash('dd if=/dev/zero of=/dev/sda bs=1M')).toBe('writes to a disk');
  });

  it('allows dd to a file', () => {
    expect(bash('dd if=/dev/zero of=blank.img bs=1M count=1')).toBeNull();
  });

  it('asks before redirecting into a disk', () => {
    expect(bash('cat x > /dev/nvme0n1')).toBe('writes to a disk');
  });

  it('asks before a fork bomb', () => {
    expect(bash(':(){ :|:& };:')).toBe('is a fork bomb');
  });

  it('asks before shutting down', () => {
    expect(bash('sudo shutdown -h now')).toBe('shuts down the machine');
  });

  it('asks before changing permissions of the whole system', () => {
    expect(bash('chmod -R 777 /')).toBe('changes permissions of the system or your home directory');
  });
});

describe('riskOf for system paths', () => {
  it('asks before redirecting into /etc', () => {
    expect(bash('echo x >> /etc/hosts')).toBe('writes to a system or credentials path');
  });

  it('asks before redirecting into ~/.ssh', () => {
    expect(bash('echo x > ~/.ssh/authorized_keys')).toBe('writes to a system or credentials path');
  });

  it('allows editing a file in the worktree', () => {
    expect(riskOf('Edit', { file_path: '/work/wt-1/src/a.ts' }, WT)).toBeNull();
  });

  it('allows writing a file outside the worktree', () => {
    expect(riskOf('Write', { file_path: '/work/other/a.ts' }, WT)).toBeNull();
  });

  it('asks before writing to /etc', () => {
    expect(riskOf('Write', { file_path: '/etc/passwd' }, WT)).toBe(
      'writes to a system or credentials path',
    );
  });

  it('asks before writing to ~/.claude', () => {
    expect(riskOf('Edit', { file_path: '~/.claude/settings.json' }, WT)).toBe(
      'writes to a system or credentials path',
    );
  });

  it('asks about a relative path that climbs into /etc', () => {
    expect(riskOf('Edit', { file_path: '../../../etc/hosts' }, WT)).toBe(
      'writes to a system or credentials path',
    );
  });
});

describe('riskOf for other tools', () => {
  it('allows an MCP tool', () => {
    expect(riskOf('mcp__github__create_issue', {}, WT)).toBeNull();
  });

  it('allows a web search', () => {
    expect(riskOf('WebSearch', { query: 'x' }, WT)).toBeNull();
  });
});
