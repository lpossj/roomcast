// Exercise the real update regression inside a Windows job that refuses
// BREAKAWAY_FROM_JOB, as hosted runners and some launchers do.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') { console.log('Skipped: Windows only'); process.exit(0); }
const root = path.resolve(__dirname, '..'), output = path.join(root, '.test/update-job');
fs.mkdirSync(output, { recursive: true });
const worker = fs.readFileSync(path.join(root, 'electron/update-launcher.cs'), 'utf8');
const definitions = worker.slice(worker.indexOf('    [StructLayout'), worker.indexOf('    private static readonly'));
const source = `using System; using System.Text; using System.Runtime.InteropServices;
internal class JobHost {
${definitions}
[DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr process, uint milliseconds);
[DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
static int Main(string[] args) {
  IntPtr job=CreateJobObject(IntPtr.Zero,null); var limits=new JobLimits(); limits.basic.flags=0x2000;
  if(job==IntPtr.Zero || !SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(JobLimits)))) throw new System.ComponentModel.Win32Exception();
  var startup=new StartupInfo();startup.size=Marshal.SizeOf(typeof(StartupInfo));ProcessInfo child;
  if(!CreateProcess(args[0],new StringBuilder("\\\""+args[0]+"\\\" \\\""+args[1]+"\\\""),IntPtr.Zero,IntPtr.Zero,false,4,IntPtr.Zero,args[2],ref startup,out child)) throw new System.ComponentModel.Win32Exception();
  try {
    if(!AssignProcessToJobObject(job,child.process)) { TerminateProcess(child.process,1);throw new System.ComponentModel.Win32Exception(); }
    ResumeThread(child.thread);WaitForSingleObject(child.process,0xffffffff);uint code;GetExitCodeProcess(child.process,out code);return (int)code;
  } finally { CloseHandle(child.thread);CloseHandle(child.process);CloseHandle(job); }
}}
`;
const file = path.join(output, 'host.cs'), executable = path.join(output, 'host.exe');fs.writeFileSync(file, source);
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const built=spawnSync(compiler,['/nologo','/out:'+executable,file],{encoding:'utf8',windowsHide:true});
if(built.error || built.status!==0) throw built.error || Error(built.stdout+built.stderr);
const result=spawnSync(executable,[process.execPath,path.join(root,'scripts/check-update-apply.cjs'),root],{stdio:'inherit',windowsHide:true,timeout:180000,env:{...process.env,ROOMCAST_EXPECT_HOST_JOB:'1'}});
if(result.error) throw result.error;process.exitCode=result.status;
