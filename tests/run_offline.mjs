/** 显式列出离线回归，避免误执行会重建活动 Blender 场景的现场测试。 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const names = [
  'verify_workflow_host', 'verify_host_registration', 'verify_review_modes', 'verify_source_quality', 'verify_join_guard',
  'verify_phase_gate', 'verify_plugin_loads', 'verify_source_structure', 'verify_tool_definitions',
  'verify_reference_tool', 'verify_detail_flow', 'verify_scene_material_flow', 'verify_review_agent', 'verify_review_provenance',
  'verify_review_must_dispatch', 'e2e_review_flow', 'verify_group_interference',
  'verify_lossless_live_output', 'verify_interference_completeness', 'verify_bvh_no_blowup',
  'verify_poke_through', 'verify_poke_through_cases', 'verify_ground_exemption',
  'verify_isolation_ack', 'verify_isolation_contact', 'verify_layered_inspection', 'verify_precision', 'iteration_test',
  'verify_research_gate', 'verify_research_quality', 'verify_exploratory_research', 'verify_source_selection', 'verify_cdp_adapter',
  'verify_independent_context', 'verify_delete_guard', 'verify_deleted_tool', 'verify_negzero',
  'verify_mcp_url_routing', 'verify_refstate_not_selfpoisoned', 'verify_material_style_review',
  'verify_view_checks', 'verify_env_install_guide', 'verify_framing_focus',
]
let failures = 0
for (const name of names) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(name + '.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 45000, windowsHide: true,
  })
  const ok = result.status === 0 && !result.error
  console.log((ok ? 'PASS ' : 'FAIL ') + name)
  if (!ok) {
    failures++
    console.error(result.error || result.stdout + result.stderr)
  }
}
console.log('OFFLINE_REGRESSION: ' + (names.length - failures) + '/' + names.length + ' passed')
process.exitCode = failures ? 1 : 0
