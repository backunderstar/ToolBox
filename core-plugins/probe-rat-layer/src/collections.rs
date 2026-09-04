//! 确定性集合别名：用 `rustc_hash::FxHashMap`/`FxHashSet` 替代 std 默认的 `HashMap`/`HashSet`。
//!
//! std 的 `HashMap`/`HashSet` 用 `RandomState`（每进程随机种子），**迭代序不确定**，导致同一份
//! 配置每次运行分层结果不同（A/B 对比不可信）。`rustc_hash::FxHash` 是**固定种子**哈希（无随机熵），
//! 同一键集下迭代序恒定；容器仍是 std `HashMap`/`HashSet`（O(1) 访问、`drain`/`entry`/`keys` 等
//! 方法齐全），作为 drop-in 替换即可让结果跨运行稳定、可复现且几乎不掉速。
//! ⚠️ 注意 `FxHashMap`/`FxHashSet` 没有 `new()`（那是 RandomState 独有），用 `default()` 构造。

pub use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
