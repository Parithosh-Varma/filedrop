# Sources and fact ledger

## Primary source

**Anthropic, Frontier Red Team — “GLM-5.3 and the spread of advanced cyber capabilities”**  
Published September 29, 2026  
https://www.anthropic.com/research/glm-5-3-and-the-spread-of-advanced-cyber-capabilities

All quantitative claims and research descriptions in the documentary are drawn from this article unless noted otherwise. The film paraphrases the paper's analysis and clearly identifies Anthropic as the source; it does not reproduce exploit code or operational attack instructions.

## On-screen claims

| Claim | Source context |
|---|---|
| More than 10,000 vulnerabilities found | Anthropic's description of Project Glasswing's defender head start |
| GLM-5.3: 50/410 end-to-end ExploitBench successes, approximately 12% | Figure 1 and “GLM-5.3 can develop working exploits end to end” |
| Claude Mythos Preview: 56/410, approximately 14% | Same evaluation; tested with safeguards disabled and access restricted |
| GLM-5.3: 4% full control-flow hijacks | Anthropic's internal Binary Exploitation benchmark, 100 sampled tasks |
| Browser vulnerabilities chained into sandbox escape and file read | Researcher-driven, isolated testing described around Figure 3 |
| 20 minutes human attention, eight hours model work, $20.40 API cost | GLM-5.3-Flash Chrome N-day case study |
| Harmful-task engagement: 0%, 64%, 92%, 100% | Direct order, false cover story, prefilled reasoning, and abliterated conditions in Figure 5 |
| Mean refusal rate approximately 95% to 6% after abliteration | Mean across JailbreakBench, HarmBench, and StrongREJECT in Figure 4 |
| Capabilities remained largely intact after abliteration | GPQA-Diamond and tested CyberGym comparisons described with Figure 4 |

## Supporting links referenced by the primary source

- NIST CAISI assessment of GLM-5.3 cyber capabilities: https://www.nist.gov/news-events/news/2026/09/caisis-assessment-zais-glm-53-cyber-capabilities
- ExploitBench paper: https://arxiv.org/abs/2605.14153
- Project Glasswing: https://www.anthropic.com/glasswing

## Editorial note

The closing phrasing—“the capability is distributing” and “the window to prepare is measured in releases”—is documentary narration synthesizing the research's implications, not a direct quotation from Anthropic.
