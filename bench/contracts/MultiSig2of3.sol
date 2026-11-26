// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// 2-of-3 multisig wallet: any owner proposes a transfer of native coin, a second owner's confirmation executes it.
contract MultiSig2of3 {
    struct Tx {
        address to;
        uint256 value;
        bytes data;
        bool executed;
        uint8 confirmations;
    }

    address[3] public owners;
    mapping(address => bool) public isOwner;
    Tx[] private txs;
    mapping(uint256 => mapping(address => bool)) public confirmed;

    event Deposit(address indexed from, uint256 amount);
    event Submitted(uint256 indexed txId, address indexed owner, address to, uint256 value);
    event Confirmed(uint256 indexed txId, address indexed owner);
    event Revoked(uint256 indexed txId, address indexed owner);
    event Executed(uint256 indexed txId);

    modifier onlyOwner() {
        require(isOwner[msg.sender], "not owner");
        _;
    }

    constructor(address[3] memory _owners) {
        for (uint256 i = 0; i < 3; i++) {
            address o = _owners[i];
            require(o != address(0) && !isOwner[o], "bad owner");
            isOwner[o] = true;
            owners[i] = o;
        }
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    function submit(address to, uint256 value, bytes calldata data) external onlyOwner returns (uint256 txId) {
        txId = txs.length;
        txs.push(Tx({to: to, value: value, data: data, executed: false, confirmations: 0}));
        emit Submitted(txId, msg.sender, to, value);
        _confirm(txId);
    }

    function confirm(uint256 txId) external onlyOwner {
        _confirm(txId);
    }

    function revoke(uint256 txId) external onlyOwner {
        Tx storage t = txs[txId];
        require(!t.executed, "already executed");
        require(confirmed[txId][msg.sender], "not confirmed");
        confirmed[txId][msg.sender] = false;
        t.confirmations -= 1;
        emit Revoked(txId, msg.sender);
    }

    function execute(uint256 txId) public onlyOwner {
        Tx storage t = txs[txId];
        require(!t.executed, "already executed");
        require(t.confirmations >= 2, "need 2 confirmations");
        t.executed = true;
        (bool ok, ) = t.to.call{value: t.value}(t.data);
        require(ok, "call failed");
        emit Executed(txId);
    }

    function txCount() external view returns (uint256) {
        return txs.length;
    }

    function getTx(uint256 txId) external view returns (address to, uint256 value, bytes memory data, bool executed, uint8 confirmations) {
        Tx storage t = txs[txId];
        return (t.to, t.value, t.data, t.executed, t.confirmations);
    }

    function _confirm(uint256 txId) internal {
        Tx storage t = txs[txId];
        require(!t.executed, "already executed");
        require(!confirmed[txId][msg.sender], "already confirmed");
        confirmed[txId][msg.sender] = true;
        t.confirmations += 1;
        emit Confirmed(txId, msg.sender);
        if (t.confirmations >= 2) execute(txId);
    }
}
