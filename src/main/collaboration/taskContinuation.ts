// 宿主确定的澄清阶段供只读和代码执行共用；已答复不是授权扩展，也不应再次等待首轮问题。
export function taskContinuationPhase(questionCount: number, pending: boolean) {
  if (!questionCount || pending) return '';
  return '宿主阶段：用户已回答此前的澄清问题，本回合明确续跑交付。首轮“提问后结束”步骤已完成；不要重复等待或重复提问。结合已保存的真实回复和实际源码完成原目标，产出带证据的报告。若确有不同的新问题，用新的 requestKey 请求澄清，不把用户回复当作权限扩展。\n';
}
