# Agent guidance

- NEVER write unit tests after you write code. 
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact. 
- If you must test a system in isolation, FIRST write all the ways it could fail, THEN write the code.
- Answer in simple words. Be brief and precise.
- Choose the smallest solution that solves the problem. Do not overengineer the problem or the fix.
- Say what is running now, what was only tested, and what remains unverified.
