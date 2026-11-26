// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Worked example for the Aptos pack prompt (not one of the benchmark contracts).
contract Escrow {
    IERC20Min public token;
    address public arbiter;
    uint256 public releaseAt;
    uint256 public total;
    mapping(address => uint256) public deposits;

    event Deposited(address indexed who, uint256 amount);
    event Claimed(address indexed who, uint256 amount);

    constructor(IERC20Min _token, address _arbiter, uint256 _releaseAt) {
        require(_arbiter != address(0), "zero arbiter");
        token = _token;
        arbiter = _arbiter;
        releaseAt = _releaseAt;
    }

    function deposit(uint256 amount) external {
        require(amount > 0, "zero amount");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        deposits[msg.sender] += amount;
        total += amount;
        emit Deposited(msg.sender, amount);
    }

    function claim() external {
        require(block.timestamp >= releaseAt, "too early");
        uint256 d = deposits[msg.sender];
        require(d > 0, "nothing to claim");
        deposits[msg.sender] = 0;
        total -= d;
        require(token.transfer(msg.sender, d), "transfer failed");
        emit Claimed(msg.sender, d);
    }

    function sweep(address to) external {
        require(msg.sender == arbiter, "not arbiter");
        uint256 bal = total;
        total = 0;
        require(token.transfer(to, bal), "transfer failed");
    }

    function shareBps(address who) public view returns (uint256) {
        if (total == 0) return 0;
        return (deposits[who] * 10000) / total;
    }
}
