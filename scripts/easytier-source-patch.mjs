import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Independently authored, deliberately restricted build of the pinned upstream.
// No MCTier application source or Npcap redistributable is used.
export async function patchEasyTier(root, pnet) {
  async function replace(file, before, after) {
    const source = await readFile(file, 'utf8');
    if (!source.includes(before)) throw new Error(`EasyTier source layout changed: ${path.basename(file)}`);
    await writeFile(file, source.replace(before, after));
  }
  const bindings = path.join(pnet, 'src/bindings/winpcap.rs');
  const source = await readFile(bindings, 'utf8');
  const offset = source.indexOf('#[link(name = "Packet")]');
  if (offset < 0) throw new Error('Missing pinned pnet Packet bindings');
  const declarations = source.slice(offset).match(/pub fn \w+\([^;]*;/g);
  if (declarations?.length !== 12) throw new Error('Unexpected pnet Packet API');
  const stubs = declarations.map(declaration => {
    const signature = declaration.slice(0, -1).replace('pub fn ', 'pub unsafe fn ');
    const result = /->\s*(LPPACKET|LPADAPTER)/.test(signature) ? 'std::ptr::null_mut()' : /->/.test(signature) ? '0' : '';
    return `#[allow(unused_variables)]\n${signature} { ${result} }`;
  });
  await writeFile(bindings, source.slice(0, offset) + '// Roomcast: raw packet capture is unavailable; use Windows IP Helper enumeration.\n' + stubs.join('\n'));
  await replace(path.join(pnet, 'src/winpcap.rs'), 'panic!("Unable to get interface list despite increasing buffer size");', 'return all_ifaces;');
  await replace(path.join(root, 'easytier/src/core.rs'), `    let _rpc_server = ApiRpcServer::new(
        cli.rpc_portal_options.rpc_portal,
        cli.rpc_portal_options.rpc_portal_whitelist,
        manager.clone(),
    )?
    .serve()
    .await?;`, '    // Roomcast sidecar has no external management RPC listener.');
  const instance = path.join(root, 'easytier/src/instance/instance.rs');
  await replace(instance, 'let mut used_ipv4 = HashSet::new();', 'let mut used_ipv4: HashSet<Ipv4Inet> = HashSet::new();');
  await replace(path.join(root, 'easytier/src/common/constants.rs'), `pub const EASYTIER_VERSION: &str = git_version::git_version!(
    args = ["--abbrev=8", "--always", "--dirty=~"],
    prefix = concat!(env!("CARGO_PKG_VERSION"), "-"),
    suffix = "",
    fallback = env!("CARGO_PKG_VERSION")
);`, 'pub const EASYTIER_VERSION: &str = "2.6.4+roomcast.1";');
  await replace(instance,
    'let default_ipv4_addr = Ipv4Inet::new(Ipv4Addr::new(10, 126, 126, 0), 24).unwrap();',
    'let default_ipv4_addr = global_ctx_c.get_ipv4().expect("Roomcast requires a configured subnet");');
  await replace(instance, `                // do not allocate ip if no peer connected
                let routes = peer_manager_c.list_routes().await;
                if routes.is_empty() {
                    next_sleep_time = 1;
                    continue;
                } else {
                    next_sleep_time = rand::thread_rng().gen_range(5..10);
                }`, `                // The first room member also needs a usable NIC.
                let routes = peer_manager_c.list_routes().await;
                next_sleep_time = rand::thread_rng().gen_range(5..10);`);
  await replace(instance, 'let dhcp_inet = used_ipv4.iter().next().unwrap_or(&default_ipv4_addr);', 'let dhcp_inet = &default_ipv4_addr;');
  await replace(instance,
    'let candidate_ipv4_addr = dhcp_inet.network().iter().find(|ip| {',
    'let candidate_ipv4_addr = std::iter::once(default_ipv4_addr).chain(dhcp_inet.network().iter()).find(|ip| {');
  await replace(path.join(root, 'Cargo.toml'), '[workspace]', '[patch.crates-io]\npnet_datalink = { path = "roomcast-pnet" }\n\n[workspace]');
  const cargo = path.join(root, 'Cargo.toml');
  const workspace = await readFile(cargo, 'utf8');
  await writeFile(cargo, workspace
    .replace(/^members = \[[\s\S]*?^\]/m, 'members = ["easytier", "easytier-rpc-build"]')
    .replace(/^default-members = .*$/m, 'default-members = ["easytier"]'));
  const windows = path.join(root, 'easytier/src/arch/windows.rs');
  await replace(windows, `pub fn add_self_to_firewall_allowlist() -> anyhow::Result<()> {
    do_add_self_to_firewall_allowlist(true)?;
    do_add_self_to_firewall_allowlist(false)?;
    Ok(())
}`, `pub fn add_self_to_firewall_allowlist() -> anyhow::Result<()> {
    // Roomcast supervisor owns all firewall rules for this process.
    Ok(())
}`);
  for (const name of ['add_interface_to_firewall_allowlist', 'remove_interface_firewall_rules']) {
    const signature = `pub fn ${name}(interface_name: &str) -> anyhow::Result<()> {`;
    await replace(windows, signature, `#[allow(unreachable_code, unused_variables)]\n${signature}\n    // Never create or remove broad, persistent interface rules in Roomcast.\n    return Ok(());`);
  }
}
