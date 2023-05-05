## Feed tangle

(Lipmaa backlinks are not shown in the diagram below, but they should exist)

```mermaid
graph RL

R["(Feed root)"]
A[adds alice]
B[adds bob]
C[deletes alices]
D[adds bob]
E[adds carol]

C-->B-->A-->R
D--->A
E-->D & C
classDef default fill:#bbb,stroke:#fff0,color:#000
```

Reducing the tangle above in a topological sort allows you to build an array
(a JSON object) `[bob, carol]`.

## Msg type

`msg.metadata.type` MUST start with `set_v1__`. E.g. `set_v1__follows`.

## Msg content

`msg.content` format:

```typescript
interface MsgContent {
  add: Array<string>,
  del: Array<string>,
  supersedes: Array<MsgHash>,
}
```

## Supersedes links

When you add or delete an item in a set, in the `supersedes` array you MUST
point to the currently-known highest-depth msg that added or deleted that item.

Also, when you *add any item*, in the `supersedes` array you SHOULD point to
all currently-known highest-depth msgs that *deleted something*.

The set of *not-transitively-superseded-by-anyone* msgs comprise the
"item roots" of the record. To allow pruning the tangle, we can delete
(or, if we want to keep metadata, "erase") all msgs preceding the item roots.

Suppose the tangle is grown in the order below, then the field roots are
highlighted in blue.

```mermaid
graph RL

R["(Feed root)"]
A[adds alice]:::blue

A-->R
classDef default fill:#bbb,stroke:#fff0,color:#000
classDef blue fill:#6af,stroke:#fff0,color:#000
```

-----

```mermaid
graph RL

R["(Feed root)"]
A[adds alice]:::blue
B[adds bob]:::blue

B-->A-->R
classDef default fill:#bbb,stroke:#fff0,color:#000
classDef blue fill:#6af,stroke:#fff0,color:#000
```

-----

```mermaid
graph RL

R["(Feed root)"]
A[adds alice]
B[adds bob]:::blue
C[deletes alices]:::blue

C-->B-->A-->R
C-- supersedes -->A

linkStyle 3 stroke-width:1px,stroke:#05f
classDef default fill:#bbb,stroke:#fff0,color:#000
classDef blue fill:#6af,stroke:#fff0,color:#000
```

-----

```mermaid
graph RL

R["(Feed root)"]
A[adds alice]
B[adds bob]:::blue
C[deletes alices]:::blue
D[adds bob]:::blue

C-->B-->A-->R
C-- supersedes -->A
D--->A

linkStyle 3 stroke-width:1px,stroke:#05f
classDef default fill:#bbb,stroke:#fff0,color:#000
classDef blue fill:#6af,stroke:#fff0,color:#000
```

-----

```mermaid
graph RL

R["(Feed root)"]
A[adds alice]
B[adds bob]:::blue
C[deletes alices]
D[adds bob]:::blue
E[adds carol]:::blue

C-->B-->A-->R
C-- supersedes -->A
D--->A
E-->D & C
E-- supersedes -->C

linkStyle 3,7 stroke-width:1px,stroke:#05f
classDef default fill:#bbb,stroke:#fff0,color:#000
classDef blue fill:#6af,stroke:#fff0,color:#000
```
