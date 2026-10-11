// 用户改变候选生命周期的操作互斥；锁只覆盖准入及持久化，模型后台运行由 Run 状态保护。
export class RunOperations {
  private readonly busy=new Set<string>();
  async execute<T>(id:string,action:()=>Promise<T>):Promise<T> {
    if(this.busy.has(id))throw new Error('此协作正在采纳、恢复或改变候选状态，请等待操作完成');
    this.busy.add(id);
    try{return await action();}finally{this.busy.delete(id);}
  }
}
